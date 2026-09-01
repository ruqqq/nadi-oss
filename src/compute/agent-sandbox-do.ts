import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { registryDb } from "../db/client";
import { ThreadRepository } from "../db/repositories/threads";
import { resolveComputeService, type ComputeServiceHostDeps } from "../agent/compute-tools";
import { createSandboxThreadHostDeps, type SandboxSweepResolution } from "./sandbox-thread-host";
import { runSandboxComputeAlarm } from "./sandbox-alarm";
import { createRepositoryPreparation } from "../agent/repository-preparation";
import { probeWorkspaceCleanliness } from "./workspace-cleanliness";
import type { ThreadComputeService } from "./thread-service";
import type { BackendReference } from "./backend";
import type { WorkRow } from "../agent/work-ledger";
import {
  SandboxSession,
  encodeSandboxError,
  type SandboxCallResult,
} from "./agent-sandbox-session";
import type { ComputeResolvePurpose, EffectiveComputeConfig } from "./types";
import { log } from "../log";

/**
 * Every method returns one of these. NOTHING throws across the RPC boundary:
 * a throw over DO RPC reaches the caller as a phantom rejection it cannot
 * attribute to a call, so failures are encoded and re-thrown on the near side.
 *
 * Defined alongside {@link SandboxSession} — the session target is the largest
 * consumer of the convention — and re-exported here because every existing
 * caller (`sandbox-thread-host.ts`, `think-thread-agent.ts`) names it off this
 * module.
 */
export type { SandboxCallResult, SandboxCallError } from "./agent-sandbox-session";

/**
 * DO storage key for {@link SandboxAlarmParams}.
 *
 * The alarm has no caller, and two of the values it needs are caller-supplied
 * BY DESIGN: `supportsProcessMonitor` decides whether background work is
 * admitted at all, and `runtimeConfig` cannot be derived from `threadId`
 * (a `SubAgent`'s facet name is a run id with no `thread_index` row). So the
 * last session's inputs are recorded here and replayed by the alarm. Nothing is
 * acquired by omission: an alarm that finds no record does NOT tick.
 */
const ALARM_PARAMS_KEY = "sandbox:alarm-params";

/**
 * Prefix for the SWEEP ROSTER: one tiny row per thread this box has served,
 * whose value is a monotonic stamp (see {@link AgentSandbox.touchSweepRoster}).
 *
 * A prefix `list`, not one map under a single key, because a map is capped at
 * the 128KB per-value limit — an agent with a few hundred threads would start
 * throwing inside `session()` and take every turn down with it.
 *
 * Kept SHORT on purpose. celld compiles a prefix scan into a SQL LIKE pattern
 * with a 49-byte budget; six bytes leaves the whole budget for the thread id.
 */
const SWEEP_ROSTER_PREFIX = "sb:sw:";

/**
 * The session inputs the alarm replays for its TICK. Written on every
 * `session()` open, so they track the owning agent's current answers rather
 * than the first ones.
 */
interface SandboxAlarmParams {
  /**
   * The thread the tick's compute service binds its back-calls to — the LAST
   * thread to open a session, since the machine is one and the tick is one.
   *
   * NEVER derived from `ctx.id.name`: since P3 that name is the AGENT id, and
   * an agent id used as a thread id addresses a thread DO that does not exist.
   * The alarm has no fallback for a missing record; it simply does not tick.
   */
  threadId: string;
  supportsProcessMonitor: boolean;
  runtimeConfig: { workspaceId: string; agentId: string };
  attachedRuntime?: BackendReference;
}

/**
 * Owns a compute sandbox and the SQLite that tracks it — the store, processes,
 * output chunks and watchers that used to live in each thread's own Durable
 * Object. The thread DO keeps the conversation; this owns the machine.
 *
 * Keyed by `agentId` (P3): ONE box per agent, shared by every thread of it and
 * by its subagent runs. `ctx.id.name` is therefore an AGENT id — it is not a
 * thread id and must never be used as one.
 *
 * The SESSION is still per-thread: `session({ threadId })` names which
 * conversation the compute service's back-calls (system reminders, the work
 * ledger) belong to. The store underneath is per-BOX and so is the alarm, which
 * is why the alarm fans its sweep out over {@link SWEEP_ROSTER_PREFIX}.
 */
export class AgentSandbox extends DurableObject<Env> {
  /**
   * The alarm params as last WRITTEN by this instance, so a turn's ~25
   * `session()` opens pay one storage write between them instead of 25. A pure
   * write-elision cache and nothing more: it is only ever compared against what
   * this same instance just persisted, so an evicted instance costs one extra
   * write and never a stale record.
   */
  private lastAlarmParams: string | undefined;

  /**
   * Thread ids whose sweep-roster row THIS instance has already written — the
   * same write-elision trick, for the same ~25-opens-per-turn reason.
   *
   * Invalidated when the alarm PRUNES a row (see {@link forgetSweepThread}).
   * Without that, a hot instance would elide the re-write and the thread would
   * be silently missing from every later sweep: the exact defect class this
   * project keeps hitting — a stale cached value that changes behaviour and
   * fails nothing.
   */
  private readonly rosterWritten = new Set<string>();

  /** Last stamp this instance wrote — see {@link touchSweepRoster}. */
  private lastRosterStamp = 0;

  /**
   * The capabilities that stayed on the thread DO — transcript reminders, the
   * work ledger and its sweep, the child-subagent lease and the "workspace
   * verified clean" bit — reached by RPC. Best-effort by
   * construction, with ONE deliberate exception on the watcher-poll reminder:
   * see `createSandboxThreadHostDeps`.
   */
  private threadHostDeps(threadId: string) {
    const deps = createSandboxThreadHostDeps(this.env, threadId);
    /**
     * The roster's invariant, enforced at the only place that can create the
     * obligation: a thread with a ledger row ALWAYS has a roster row.
     *
     * `session()` writes one too, but that write is elided per instance and
     * can have been pruned since. Re-asserting here — BEFORE the row is
     * registered, and with a fresh stamp — is also what closes the prune race:
     * the alarm deletes a roster row only if its stamp is unchanged since the
     * pass began, so a register that lands mid-pass keeps it.
     *
     * Applied to the ROUTED sink, not just this thread's: since a register can
     * now target the thread that owns the row rather than the one that
     * resolved the service, rostering `threadId` here would put the wrong
     * thread on the sweep list and leave the real owner's row unswept.
     */
    const rosteringSink = (rowThreadId: string) => {
      const sink = deps.workLedgerFor(rowThreadId);
      return {
        ...sink,
        register: async (row: WorkRow) => {
          await this.touchSweepRoster(rowThreadId, { force: true });
          await sink.register(row);
        },
      };
    };
    return {
      ...deps,
      workLedgerFor: rosteringSink,
      workLedger: rosteringSink(threadId),
    };
  }

  /**
   * Record that `threadId` has a work ledger this box's alarm must sweep.
   *
   * The stamp is the value, not just presence: {@link forgetSweepThread} deletes
   * only on an unchanged stamp, so any concurrent touch cancels a prune that was
   * decided against older evidence.
   *
   * KNOWN COST — a `SubAgent`'s id is a RUN id, not a thread id, and it is
   * rostered here like any other. `threadHostDeps(runId)` resolves it against
   * `THINK_THREAD_AGENT` and `getAgentByName` CREATES that DO on demand, so
   * the next alarm instantiates and hydrates a `ThinkThreadAgent` named after
   * a run id, runs a real sweep against its empty ledger, finds nothing owed
   * and prunes it. One alarm's worth of DO creation plus storage for an object
   * nothing reads again.
   *
   * NOT fixed by refusing to roster run ids, and the reason is worth writing
   * down: every back-call a subagent's compute makes ALREADY goes to that same
   * phantom DO — `openSandbox()` passes `this.name`, which for a `SubAgent` is
   * the run id, so its ledger rows and its reminders land there too. Dropping
   * the roster entry alone would leave those rows on the phantom with nothing
   * left to sweep them. The real fix is routing a subagent's back-calls to a
   * DO that exists (its parent thread, or the facet itself), which is a change
   * to `ThinkThreadAgent.openSandbox`, not to this line.
   */
  private async touchSweepRoster(threadId: string, options?: { force?: boolean }): Promise<void> {
    if (!options?.force && this.rosterWritten.has(threadId)) return;
    // Strictly increasing within an instance, so two touches in the same
    // millisecond still produce different stamps and the compare-and-delete
    // below cannot mistake the second for the first.
    this.lastRosterStamp = Math.max(Date.now(), this.lastRosterStamp + 1);
    await this.ctx.storage.put<number>(SWEEP_ROSTER_PREFIX + threadId, this.lastRosterStamp);
    this.rosterWritten.add(threadId);
  }

  /**
   * Min-fold of the ledger horizons of `entries` — the earliest moment any of
   * them needs this box's single alarm.
   *
   * One thread's horizon armed alone does not merely under-serve the others: a
   * Durable Object has ONE alarm, so it REPLACES a nearer wake they needed.
   */
  private async foldWorkHorizon(
    entries: { threadId: string }[],
    now?: number,
  ): Promise<number | null> {
    let min: number | null = null;
    for (const entry of entries) {
      const horizon = await this.threadHostDeps(entry.threadId).getWorkHorizon(now);
      if (horizon !== null && (min === null || horizon < min)) min = horizon;
    }
    return min;
  }

  /**
   * Does ANY thread this box serves have a live child agent on the machine?
   *
   * OR-folded over the roster because the question is about the MACHINE, and
   * since P3 the machine is the agent's. Asking only the resolving thread lets
   * a sibling tear down a container another thread's subagent is running on.
   * Short-circuits on the first `true`, and an unreachable thread already
   * answers `true` (`createSandboxThreadHostDeps` picks the fallback that
   * cannot lose work), so this can only ever be MORE conservative than the
   * single-thread answer it replaces — never less.
   *
   * Affordable: every caller is a teardown or reclaim decision
   * (`releaseIfIdle`, `releaseIfReclaimable`, `execShutdown`), not a per-exec
   * one. The resolving thread is asked FIRST so the common "this thread has a
   * child" case still costs one call.
   */
  private async rosterHasBlockingWork(threadId: string): Promise<boolean> {
    if (await this.threadHostDeps(threadId).hasBlockingWork()) return true;
    for (const entry of await this.readSweepRoster()) {
      if (entry.threadId === threadId) continue;
      if (await this.threadHostDeps(entry.threadId).hasBlockingWork()) return true;
    }
    return false;
  }

  /**
   * {@link foldWorkHorizon} over the CURRENT roster — the `getWorkHorizon` the
   * alarm's compute service arms with, so its `armAlarm` covers every thread
   * this box serves rather than only the one whose session it replayed.
   *
   * Reads the roster fresh because it is called from inside the tick, before
   * the sweep has decided what to prune.
   */
  private async rosterWorkHorizon(now?: number): Promise<number | null> {
    return this.foldWorkHorizon(await this.readSweepRoster(), now);
  }

  /** Every thread this box must sweep, with the stamp the prune compares against. */
  private async readSweepRoster(): Promise<{ threadId: string; stamp: number }[]> {
    const rows = await this.ctx.storage.list<number>({ prefix: SWEEP_ROSTER_PREFIX });
    return [...rows].map(([key, stamp]) => ({
      threadId: key.slice(SWEEP_ROSTER_PREFIX.length),
      stamp,
    }));
  }

  /**
   * Drop a swept-clean thread from the roster — compare-and-delete on `stamp`.
   *
   * Pruning is not an optimization: without it the alarm would keep waking (and
   * on the archive path, RESURRECTING) the DO of every thread the agent has ever
   * had, forever. It is safe only because it is evidence-based — the caller has
   * a REACHABLE "nothing open, nothing owed" answer — and because any newer
   * touch changes the stamp and vetoes the delete.
   */
  private async forgetSweepThread(threadId: string, stamp: number): Promise<void> {
    const current = await this.ctx.storage.get<number>(SWEEP_ROSTER_PREFIX + threadId);
    if (current !== stamp) return;
    await this.ctx.storage.delete(SWEEP_ROSTER_PREFIX + threadId);
    this.rosterWritten.delete(threadId);
  }

  /**
   * The thread's workspace/agent, read from D1.
   *
   * A FALLBACK, not the general answer, and the distinction is load-bearing: a
   * `SubAgent`'s facet name is a RUN id with no `thread_index` row at all, and
   * its real config comes from its PARENT thread (`SubAgent`
   * `resolveRuntimeConfigForThink`). So `session()` requires the caller — which
   * is the authority on its own identity — to state it, and this row read serves
   * only the entry points that are top-level threads by construction.
   */
  private async runtimeConfigFor(
    threadId: string,
  ): Promise<{ workspaceId: string; agentId: string }> {
    const thread = await new ThreadRepository(registryDb(this.env)).getById(threadId);
    if (!thread) throw new Error(`thread_not_found: ${threadId}`);
    return { workspaceId: thread.workspaceId, agentId: thread.agentId };
  }

  /**
   * Builds the compute service against THIS DO's storage.
   *
   * `supportsProcessMonitor` is a REQUIRED caller-supplied value, never a
   * default. It is the flag that admits background work at all: with it false
   * `execWatch` throws `compute_process_monitor_unavailable`
   * (`thread-service.ts:1660`), a long-running `exec` is backgrounded WITHOUT a
   * watcher (`:1189`), and `autoWatchRunningProcesses` returns an empty list
   * (`:1893`). None of that FAILS — the tool surface merely changes shape — so a
   * wrong value here turns background work off silently, with every test still
   * green. Making it required is what stops a caller acquiring that behaviour by
   * forgetting to state it; the thread DO's real value is
   * `ThinkThreadAgent.processMonitorEnabled()`, threaded through
   * `openSandbox()`.
   */
  private async resolveService(
    threadId: string,
    options: {
      supportsProcessMonitor: boolean;
      /** See {@link ComputeResolvePurpose}. Only the deletion teardown sets it. */
      purpose?: ComputeResolvePurpose;
      attachedRuntime?: BackendReference;
      /**
       * The caller's own workspace/agent. Supplied by `session()`, whose caller
       * knows it; omitted only by the entry points that are top-level threads
       * by construction, which fall back to the D1 row — see
       * {@link runtimeConfigFor}.
       */
      runtimeConfig?: { workspaceId: string; agentId: string };
      /**
       * WHOSE open work this service's `armAlarm` min-folds into the box's one
       * alarm.
       *
       * REQUIRED, and the reason is Task 1b's Finding 1: `armAlarm` is the
       * sandbox's single arm site, a Durable Object has exactly ONE alarm, and
       * that alarm serves every thread of the agent. A per-thread horizon
       * armed here does not merely under-serve the others, it REPLACES a
       * nearer wake one of them needed. Nothing fails when it is wrong — the
       * row is terminalized minutes late and its fault reminder arrives with
       * it — so the choice is stated at every call site rather than defaulted.
       *
       * `"resolving-thread"`: only the thread this service is for. What a
       * `session()` open uses, because folding the roster would cost one
       * cross-DO RPC per rostered thread on each of a turn's ~25 arms, every
       * one of them waking a hibernating `ThinkThreadAgent`.
       * `"roster"`: every thread this box serves. What the ALARM uses, on both
       * its armed and its fallback path.
       */
      workHorizon: "resolving-thread" | "roster";
    },
  ) {
    // `probeWorkspaceCleanliness` runs against THIS DO's own service rather
    // than resolving a second one: it fires from `resolveIdleDisposition`, i.e.
    // from a method of the service the caller already holds, so the holder is
    // stamped by then and re-resolving would only pay the D1 reads twice. A
    // null holder is unreachable; the arm below says what it would mean.
    const local: { service: ThreadComputeService | null } = { service: null };
    // `onFreshRuntimeAcquired` gets a SECOND service, and that is not an
    // oversight — a holder here DEADLOCKS.
    //
    // It fires from inside `readOrAcquireRuntime`, i.e. while that service's
    // `acquisitionInFlight` still holds the very acquisition that is awaiting
    // this callback. `prepareRepositories` runs `exec`, `exec` calls
    // `ensureRuntime`, and `ensureRuntime` goes through `boundedAcquisition` —
    // which returns the in-flight promise rather than reading the (already
    // `active`) store. The acquire waits on preparation; preparation waits on
    // the acquire; the only exit is `ACQUIRE_DEADLINE_MS`, 25 seconds later,
    // with a `sandbox_acquire_deadline` and no repositories cloned.
    //
    // The thread-local path this replaced was accidentally immune: its
    // `onFreshRuntimeAcquired` called `resolveComputeService` again, and the
    // FRESH service's `acquisitionInFlight` is undefined, so its
    // `readOrAcquireRuntime` sees `status: "active"` (set before this callback
    // runs) and returns at once. Restoring that is the fix.
    //
    // And it is not the re-entrancy the plan feared: `resolveComputeService` is
    // a plain function call in this same isolate. There is no RPC, so there is
    // no second trip through this DO's input lock. `onFreshRuntimeAcquired` is
    // omitted from the second service so the shape cannot recurse even if a
    // future change made it acquire.
    const prepareRepositories = createRepositoryPreparation({
      env: this.env,
      threadId,
      resolveComputeService: async () => {
        const prepared = await this.buildService(threadId, options, {});
        return prepared ? { service: prepared.service } : null;
      },
    });
    const resolved = await this.buildService(threadId, options, {
      probeWorkspaceCleanliness: async () => {
        if (!local.service) return { state: "probe_failed", reason: "no_compute_service" };
        return probeWorkspaceCleanliness((command, timeoutMs) =>
          local.service!.execRun({ command, timeoutMs, label: "workspace cleanliness" }),
        );
      },
      onFreshRuntimeAcquired: async () => {
        const result = await prepareRepositories();
        // A SKIP is not an error, so nothing throws and the `catch` around this
        // call never fires — which is exactly how a provider-contract mismatch
        // left every fresh agent sandbox with an empty /workspace while the logs
        // stayed clean. Skips are the interesting outcome here; say so, or the
        // next such break is invisible too.
        if (result.skipped?.length) {
          log.warn("compute.repository_preparation_skipped", {
            threadId,
            skipped: result.skipped.map((entry) => `${entry.name}: ${entry.reason}`),
          });
        }
      },
    });
    local.service = resolved?.service ?? null;
    return resolved;
  }

  /**
   * One `ThreadComputeService` against THIS DO's storage.
   *
   * `hooks` carries only the two deps whose implementation depends on WHICH
   * service is being built — see {@link resolveService}, which builds the
   * caller's service with both and repository preparation's without either.
   */
  private async buildService(
    threadId: string,
    options: {
      supportsProcessMonitor: boolean;
      purpose?: ComputeResolvePurpose;
      attachedRuntime?: BackendReference;
      runtimeConfig?: { workspaceId: string; agentId: string };
      /** See {@link resolveService}'s option of the same name. */
      workHorizon: "resolving-thread" | "roster";
    },
    hooks: {
      probeWorkspaceCleanliness?: ComputeServiceHostDeps["probeWorkspaceCleanliness"];
      onFreshRuntimeAcquired?: ComputeServiceHostDeps["onFreshRuntimeAcquired"];
    },
  ) {
    const host = this.threadHostDeps(threadId);
    return resolveComputeService({
      env: this.env,
      threadId,
      storage: this.ctx.storage,
      resolveRuntimeConfig: async () => options.runtimeConfig ?? this.runtimeConfigFor(threadId),
      ...host,
      // Overrides the single-thread `getWorkHorizon` the spread above carries
      // — see `options.workHorizon`. AFTER the spread deliberately: the roster
      // fold has to win, and a reader has to be able to see that it does.
      getWorkHorizon:
        options.workHorizon === "roster"
          ? (now?: number) => this.rosterWorkHorizon(now)
          : host.getWorkHorizon,
      // Also an override of the spread above, and unconditional — unlike the
      // horizon there is no cheap-vs-correct trade here. It is asked only on
      // teardown/reclaim paths, and the wrong answer destroys a running child's
      // container.
      hasBlockingWork: () => this.rosterHasBlockingWork(threadId),
      // THIS DO's own alarm, not a back-call. A Durable Object has exactly one
      // alarm, which is the same single-outstanding-wake shape the thread DO's
      // cancel-then-set schedule id used to give `armAlarm` — so `armAlarm`
      // stays the one arm site and its min-fold still holds. Local because the
      // sandbox owns the machine: the tick that this alarm drives reads and
      // writes THIS DO's store, and routing its wake through another DO only
      // added a hop that could fail.
      scheduleEviction: (timestampMs) => this.ctx.storage.setAlarm(timestampMs),
      cancelEviction: () => this.ctx.storage.deleteAlarm(),
      supportsProcessMonitor: options.supportsProcessMonitor,
      // NOT on the plan's list of thread-bound deps, and it had to be: the
      // thread DO supplies `processMonitorEnabled && !attachedRuntime`, while
      // `resolveComputeService` used to default an omitted value to
      // `!attachedRuntime` alone — which would let a runtime that cannot deliver
      // a completion reminder background a long-running exec anyway, background
      // work turned back ON silently. The field is REQUIRED now, so the
      // omission cannot recur; the derivation stays here because it is a pure
      // function of the two values the caller already states, rather than a
      // third input a caller could get wrong.
      backgroundLongRunningExec: options.supportsProcessMonitor && !options.attachedRuntime,
      ...(options.purpose ? { purpose: options.purpose } : {}),
      // Plain serializable data, not a capability: an attached subagent's
      // parent runtime reference travels as an RPC INPUT. Nothing to relocate.
      ...(options.attachedRuntime ? { attachedRuntime: options.attachedRuntime } : {}),
      ...(hooks.probeWorkspaceCleanliness
        ? { probeWorkspaceCleanliness: hooks.probeWorkspaceCleanliness }
        : {}),
      ...(hooks.onFreshRuntimeAcquired
        ? { onFreshRuntimeAcquired: hooks.onFreshRuntimeAcquired }
        : {}),
    });
  }

  /**
   * Opens a per-turn session: ONE resolved {@link ThreadComputeService} wrapped
   * in an {@link SandboxSession} `RpcTarget`, so the several D1 reads and the
   * GitHub App token mint `resolveComputeService` costs are paid once for the
   * turn — matching the thread DO's own memoization at
   * `think-thread-agent.ts:1418`, which is why a flat method-per-operation
   * surface was rejected.
   *
   * `workspaceId` and `config` ride along because every consumer of
   * `resolveComputeService` needs them beside the service (tool gating reads
   * `config.allowedHosts`, `config.secretEnvNames`, `config.editableEnv`) and
   * they are plain JSON, so shipping them with the session costs nothing and
   * saves a second round trip.
   *
   * `value: null` means compute is DISABLED for this thread — the same signal
   * `resolveComputeService` gives by returning `null`, which callers must treat
   * as "hide every compute tool, schedule no eviction alarm". That is distinct
   * from `ok: false`, which means the resolve itself failed.
   */
  async session(input: {
    threadId: string;
    /** Required — see {@link resolveService}. The caller states it; no default. */
    supportsProcessMonitor: boolean;
    /**
     * REQUIRED, and never inferred from `threadId`. A `SubAgent` runs under a
     * facet name that is a RUN id — there is no `thread_index` row for it, and
     * its workspace/agent are its PARENT's. Reading the row here would throw
     * `thread_not_found` for every subagent turn; guessing a default would bill
     * and configure it against the wrong workspace. The caller knows.
     */
    runtimeConfig: { workspaceId: string; agentId: string };
    /**
     * Why the session is being opened. Plain data, so it crosses the RPC
     * boundary unchanged. Only `"teardown"` behaves differently, and only by
     * lifting the two AGENT-availability gates — see
     * {@link ComputeResolvePurpose}.
     */
    purpose?: ComputeResolvePurpose;
    /** An attached subagent's parent runtime, when this thread shares a machine. */
    attachedRuntime?: BackendReference;
  }): Promise<
    SandboxCallResult<{
      session: SandboxSession;
      workspaceId: string;
      config: EffectiveComputeConfig;
    } | null>
  > {
    try {
      // Recorded BEFORE the resolve, and on every open: these are the inputs the
      // alarm has no caller to ask for. Written even when the resolve then
      // returns `null` (compute disabled) — the values are still the right ones
      // to replay if compute is turned back on before the next wake, and an
      // alarm that finds them still refuses to tick a disabled thread, because
      // `resolveService` returns `null` for it too.
      const params: SandboxAlarmParams = {
        threadId: input.threadId,
        supportsProcessMonitor: input.supportsProcessMonitor,
        runtimeConfig: input.runtimeConfig,
        ...(input.attachedRuntime ? { attachedRuntime: input.attachedRuntime } : {}),
      };
      const encoded = JSON.stringify(params);
      if (encoded !== this.lastAlarmParams) {
        await this.ctx.storage.put<SandboxAlarmParams>(ALARM_PARAMS_KEY, params);
        this.lastAlarmParams = encoded;
      }
      // The sweep roster. Written on EVERY thread's open, not just the last
      // one's: the record above is a single slot the next thread overwrites,
      // and the alarm that replaced the per-thread alarms must still sweep
      // every thread this box serves. `workLedger.register` re-asserts it —
      // see {@link threadHostDeps}.
      await this.touchSweepRoster(input.threadId);
      const resolved = await this.resolveService(input.threadId, {
        supportsProcessMonitor: input.supportsProcessMonitor,
        runtimeConfig: input.runtimeConfig,
        // A turn arms ~25 times; the roster fold is one cross-DO RPC per
        // rostered thread and each wakes a hibernating thread DO. The ALARM
        // pays that instead, once per wake — see the option's doc, and the
        // residual it names.
        workHorizon: "resolving-thread",
        ...(input.purpose ? { purpose: input.purpose } : {}),
        ...(input.attachedRuntime ? { attachedRuntime: input.attachedRuntime } : {}),
      });
      if (!resolved) return { ok: true, value: null };
      return {
        ok: true,
        value: {
          session: new SandboxSession(resolved.service),
          workspaceId: resolved.workspaceId,
          config: resolved.config,
        },
      };
    } catch (error) {
      log.warn("agent_sandbox.session_failed", {
        threadId: input.threadId,
        error: String(error),
      });
      // The ENCODER, not a hand-rolled `{ code, message }`: a `ComputeError`
      // thrown out of the resolve would otherwise reach the near side as an
      // anonymous error with its code buried in a `session_failed:`-prefixed
      // message, and `toErrorResult` would show the model a string it cannot
      // act on. Latent today — `resolveComputeService` has no throw of its own.
      return { ok: false, error: encodeSandboxError(error) };
    }
  }

  /**
   * The compute alarm — the machine's own tick, on the DO that owns the machine.
   *
   * The ordering-critical body is {@link runSandboxComputeAlarm}; this method is
   * its wiring. Read that doc before changing anything here: `resolve -> tick ->
   * sweep -> fallback` has been broken three times.
   *
   * The session is opened HERE, inside this invocation, and nothing is reused
   * from an earlier one: an alarm is a new invocation, and whether an RPC stub
   * survives one is unproven.
   *
   * ONE TICK, MANY SWEEPS. The machine is agent-scoped, so the tick is: it polls
   * one store's watchers and one environment's idle disposition, and running it
   * per thread would poll each watcher N times. The LEDGER is per thread and
   * lives on each thread's own DO, and this alarm is the only wake it has left
   * (P1 moved the compute alarm off the thread DO; `runSandboxComputeAlarm`
   * explains why a second alarm cannot be added back). So the sweep fans out
   * over {@link SWEEP_ROSTER_PREFIX} — every thread this box has served — and
   * `workHorizon` min-folds their horizons. A sweep driven off the tick's single
   * `params.threadId` would strand every other thread's open rows forever, which
   * is the exact bug this project exists to kill.
   */
  async alarm(): Promise<void> {
    const params = (await this.ctx.storage.get<SandboxAlarmParams>(ALARM_PARAMS_KEY)) ?? null;
    // THE TRAP, and it is gone. This used to fall back to `this.ctx.id.name`
    // when no session had been recorded. That name is now the AGENT id, so the
    // fallback would have swept — and delivered reminders into — a thread DO
    // named after an agent, silently and forever. There is no identity to
    // recover here: an alarm with neither a recorded tick nor a roster entry has
    // nothing to do, and says so.
    const roster = await this.readSweepRoster();
    // Log scope only, and `?? unknown` is deliberate: `ctx.id.name` is
    // `string | undefined` (an `idFromString` id carries no name), and coercing
    // it into an identity is precisely the mistake above.
    const agentId = this.ctx.id.name ?? params?.runtimeConfig.agentId ?? "unknown";
    if (!params && roster.length === 0) {
      log.warn("agent_sandbox.alarm_without_recorded_session", { agentId });
      return;
    }
    // Mutated by the sweep: a thread pruned there must not then contribute a
    // horizon that re-arms this box on its behalf.
    let live = roster;
    // Hoisted for `setSandboxDeclaredClean` below — see FINDING 3 there.
    const tickThreadId = params?.threadId ?? null;
    await runSandboxComputeAlarm({
      // Log scope only. Never a sweep target — see the field's own doc.
      agentId,
      openSession: async () => {
        // No recorded session inputs means no tick: `supportsProcessMonitor`
        // and `runtimeConfig` are required precisely so nothing acquires them
        // by omission, and an alarm is not exempt. The sweep below still runs —
        // that is the half that must keep happening when compute is gone.
        if (!params) return null;
        return this.resolveService(params.threadId, {
          supportsProcessMonitor: params.supportsProcessMonitor,
          runtimeConfig: params.runtimeConfig,
          // FINDING 1. The fallback `workHorizon` below only runs when the
          // tick armed NOTHING (`armed === false` in `runSandboxComputeAlarm`),
          // so on the ordinary armed path the roster fold used to be skipped
          // entirely and the box armed for one thread's horizon. Both paths
          // fold the roster now.
          workHorizon: "roster",
          ...(params.attachedRuntime ? { attachedRuntime: params.attachedRuntime } : {}),
        });
      },
      sweepWorkLedger: async (resolved) => {
        const remaining: typeof live = [];
        for (const entry of live) {
          const host = this.threadHostDeps(entry.threadId);
          const resolution: SandboxSweepResolution =
            resolved === undefined
              ? { kind: "unresolved" }
              : resolved === null
                ? { kind: "disabled" }
                : {
                    // A FRESH target per thread over the tick's already-resolved
                    // service, not a stashed or reused one: an `RpcTarget` is not
                    // proven to survive being sent twice, and each lives exactly
                    // as long as this alarm invocation.
                    kind: "session",
                    session: new SandboxSession(resolved.service),
                    workspaceId: resolved.workspaceId,
                    config: resolved.config,
                  };
          await host.sweepWorkLedger(resolution);
          // Prune on EVIDENCE, never on silence: `reachable` is the whole point
          // of `probeWorkHorizon`. An unreachable thread and a swept-clean one
          // both answer `horizon: null`, and dropping the first would lose the
          // sweep of a thread that still has open work.
          const probe = await host.probeWorkHorizon();
          if (probe.reachable && probe.horizon === null) {
            await this.forgetSweepThread(entry.threadId, entry.stamp);
            continue;
          }
          remaining.push(entry);
        }
        live = remaining;
      },
      // Min-fold across every thread still on the roster. One thread's horizon
      // would arm this box for that thread and strand the rest.
      //
      // `live`, not a fresh roster read: the sweep above has just pruned the
      // threads with nothing open, and a pruned thread must not then contribute
      // a horizon that re-arms this box on its behalf.
      workHorizon: (now) => this.foldWorkHorizon(live, now),
      setAlarm: (timestampMs) => this.ctx.storage.setAlarm(timestampMs),
      // The tick's own thread — this is the machine's "clean" bit, written by
      // the thread whose session the tick replayed, exactly as before.
      //
      // FINDING 3. The thread id is HOISTED out of the closure rather than
      // re-read from `params` with an `if (!params) return` guard. That guard
      // was unreachable (this is only called inside `if (resolved)`, and
      // `openSession` returns null when there are no params) and it no-opped
      // SILENTLY — a later refactor that made it live would have dropped a
      // clean-bit reset with nothing to show for it. Unreachable now means a
      // throw, which the alarm's own tick guard logs as `alarm_tick_failed`.
      setSandboxDeclaredClean: async (clean) => {
        if (tickThreadId === null) {
          throw new Error("agent_sandbox.clean_bit_without_recorded_session");
        }
        await this.threadHostDeps(tickThreadId).setSandboxDeclaredClean(clean);
      },
    });
  }
}
