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
 * The session inputs the alarm replays. Written on every `session()` open, so
 * they track the owning agent's current answers rather than the first ones.
 */
interface SandboxAlarmParams {
  /**
   * Recorded rather than read off `ctx.id.name`, which is populated for an
   * `idFromName` id but is not something this class should depend on for a
   * value it already has in hand.
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
 * Keyed by `threadId`, so behaviour matches the thread-local path it replaces.
 * P3 re-keys it to `agentId`.
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
   * The capabilities that stayed on the thread DO — transcript reminders, the
   * work ledger and its sweep, the child-subagent lease and the "workspace
   * verified clean" bit — reached by RPC. Best-effort by
   * construction, with ONE deliberate exception on the watcher-poll reminder:
   * see `createSandboxThreadHostDeps`.
   */
  private threadHostDeps(threadId: string) {
    return createSandboxThreadHostDeps(this.env, threadId);
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
    },
    hooks: {
      probeWorkspaceCleanliness?: ComputeServiceHostDeps["probeWorkspaceCleanliness"];
      onFreshRuntimeAcquired?: ComputeServiceHostDeps["onFreshRuntimeAcquired"];
    },
  ) {
    return resolveComputeService({
      env: this.env,
      threadId,
      storage: this.ctx.storage,
      resolveRuntimeConfig: async () => options.runtimeConfig ?? this.runtimeConfigFor(threadId),
      ...this.threadHostDeps(threadId),
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
      const resolved = await this.resolveService(input.threadId, {
        supportsProcessMonitor: input.supportsProcessMonitor,
        runtimeConfig: input.runtimeConfig,
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
   */
  async alarm(): Promise<void> {
    const params = (await this.ctx.storage.get<SandboxAlarmParams>(ALARM_PARAMS_KEY)) ?? null;
    // `ctx.id.name` is populated for the `idFromName` id every caller uses, and
    // is the only identity an alarm that predates the first recorded session
    // has. Without either there is no thread to sweep for and nothing to tick.
    const threadId = params?.threadId ?? this.ctx.id.name;
    if (!threadId) {
      log.warn("agent_sandbox.alarm_without_thread_id", {});
      return;
    }
    const host = this.threadHostDeps(threadId);
    await runSandboxComputeAlarm({
      threadId,
      openSession: async () => {
        // No recorded session inputs means no tick: `supportsProcessMonitor`
        // and `runtimeConfig` are required precisely so nothing acquires them
        // by omission, and an alarm is not exempt. The sweep below still runs —
        // that is the half that must keep happening when compute is gone.
        if (!params) return null;
        return this.resolveService(threadId, {
          supportsProcessMonitor: params.supportsProcessMonitor,
          runtimeConfig: params.runtimeConfig,
          ...(params.attachedRuntime ? { attachedRuntime: params.attachedRuntime } : {}),
        });
      },
      sweepWorkLedger: async (resolved) => {
        const resolution: SandboxSweepResolution =
          resolved === undefined
            ? { kind: "unresolved" }
            : resolved === null
              ? { kind: "disabled" }
              : {
                  kind: "session",
                  // A FRESH target over the tick's already-resolved service, not
                  // a stashed one: it lives exactly as long as this alarm
                  // invocation, which is the span the sweep runs in.
                  session: new SandboxSession(resolved.service),
                  workspaceId: resolved.workspaceId,
                  config: resolved.config,
                };
        await host.sweepWorkLedger(resolution);
      },
      workHorizon: (now) => host.getWorkHorizon(now),
      setAlarm: (timestampMs) => this.ctx.storage.setAlarm(timestampMs),
      setSandboxDeclaredClean: (clean) => host.setSandboxDeclaredClean(clean),
    });
  }
}
