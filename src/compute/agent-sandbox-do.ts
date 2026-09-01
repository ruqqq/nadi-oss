import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { registryDb } from "../db/client";
import { ThreadRepository } from "../db/repositories/threads";
import { resolveComputeService, type ComputeServiceHostDeps } from "../agent/compute-tools";
import { createSandboxThreadHostDeps, type SandboxSweepResolution } from "./sandbox-thread-host";
import { runSandboxComputeAlarm } from "./sandbox-alarm";
import {
  createRepositoryPreparation,
  currentPreparationSignature,
  reclaimThreadWorkspaces,
  type ReclaimExecService,
  type RepositoryPreparationResult,
} from "../agent/repository-preparation";
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
 * How many consecutive failed preparations one thread gets per DO wake before
 * this box stops retrying it — see {@link AgentSandbox.ensureThreadWorkspacePrepared}.
 *
 * Small on purpose. The first attempt is the real one; the next two cover a
 * transient network or registry blip. Beyond that the evidence says the
 * configuration is broken, and each further attempt costs the user the first
 * tool call of a turn.
 */
const MAX_PREPARATION_ATTEMPTS = 3;

/**
 * Prefix for the PENDING-RECLAIM set: one tiny row per thread whose working
 * directory this box still owes a removal, written when the thread ends and
 * deleted when the box has actually removed it.
 *
 * A row rather than an immediate `rm`, because LAZINESS IS THE POINT. Removing
 * a directory means an `exec`, and an `exec` WAKES the sprite. Auto-archive is
 * a cron over many idle threads: doing the work eagerly would wake every idle
 * agent's box nightly and bill them all awake, to delete a directory nobody is
 * waiting on. The row costs nothing, survives eviction, and is swept the next
 * time a turn has the box awake for its own reasons.
 *
 * Separate from {@link SWEEP_ROSTER_PREFIX} on purpose, and this is the one
 * place the two must not be conflated: a reclaim target is precisely a thread
 * LEAVING the roster (the alarm prunes a thread once its ledger is provably
 * clean, and an archived thread's DO is destroyed), so keying the reclaim off
 * the roster would both miss every already-pruned thread and require keeping
 * archived threads rostered — resurrecting the DOs the prune exists to stop
 * resurrecting.
 *
 * Kept SHORT for celld's 49-byte LIKE budget, exactly like the roster prefix.
 */
const PENDING_RECLAIM_PREFIX = "sb:rc:";

/**
 * How many thread workspaces one reclaim pass removes.
 *
 * The pass is ONE `exec` whose command names every root, so the cap bounds the
 * command string rather than a round-trip count. An agent whose auto-archive
 * cron retired hundreds of threads between two turns would otherwise build a
 * command tens of kilobytes long on the first tool call of the next turn; what
 * does not fit is simply reclaimed by the pass after it.
 */
const RECLAIM_BATCH_LIMIT = 25;

/**
 * Consecutive failed reclaim passes per DO wake before this box stops trying.
 *
 * Same shape and same reasoning as {@link MAX_PREPARATION_ATTEMPTS}, and IN
 * MEMORY for the same reason: the cap exists so a permanently failing `rm`
 * cannot stall the first tool call of every turn, and it must never become a
 * reason a directory is never reclaimed. It dies with the wake.
 */
const MAX_RECLAIM_ATTEMPTS = 3;

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
  /**
   * The thread whose working directory the tick's service uses — the parent's,
   * for a subagent. Optional ONLY to keep a record written by the previous
   * deployment replayable (see the two-adjacent-versions rule in CLAUDE.md);
   * a session open rewrites it. The fallback is safe here specifically: the
   * alarm's service polls process status and arms alarms, and never issues a
   * command that takes the default cwd.
   */
  workspaceThreadId?: string;
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

  /** In-flight workspace preparations, keyed by thread — see {@link ensureThreadWorkspacePrepared}. */
  private readonly preparationInFlight = new Map<string, Promise<void>>();

  /**
   * The in-flight reclaim pass — see {@link reclaimPendingWorkspaces}.
   *
   * Not an optimisation, for the same reason the preparation latch is not: two
   * `exec`s in one turn both reach `ensureWorkspaceRootOnce`, and two
   * concurrent passes would each read the same pending rows and each issue
   * `rm -rf` for them. Concurrent callers AWAIT the first pass.
   */
  private reclaimInFlight: Promise<void> | undefined;

  /** Consecutive failed reclaim passes this wake — see {@link MAX_RECLAIM_ATTEMPTS}. */
  private reclaimFailures = 0;

  /**
   * Consecutive failed preparations, per thread — see
   * {@link ensureThreadWorkspacePrepared}'s attempt cap.
   *
   * IN MEMORY on this DO instance, deliberately, and not in storage. The cap
   * exists to stop a permanently failing setup command from blocking the first
   * tool call of every turn; it must NEVER become a reason a thread stays
   * unprepared forever. An in-memory counter dies with the DO's wake, so the
   * worst it can do is skip a few attempts inside one sitting and try again in
   * the next — self-healing in the safe direction, with no writes and no execs.
   */
  private readonly preparationFailures = new Map<
    string,
    {
      key: string;
      count: number;
      /**
       * The configuration this thread was failing to prepare, as
       * `RepositoryPreparationResult.signature`.
       *
       * The suspension is a statement about a CONFIGURATION, not about a
       * thread. Without this the cap outlived the thing it was capping: a user
       * whose `setup_script` had a typo fixed it, and every turn for the rest
       * of the DO's wake still skipped preparation, because the early return
       * fires before `prepare()` and nothing else could move the counter.
       *
       * `null` when there was no configuration to prepare, which never reaches
       * the cap (such a run has no failures).
       */
      signature: string | null;
    }
  >();

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
   * Prepare `threadId`'s working directory, at most once per DO instance per
   * thread while a run is outstanding.
   *
   * The in-flight map is not an optimisation. Two `exec`s in one turn both reach
   * `ensureWorkspaceRootOnce` on the SAME service, and its own latch is set
   * before the await — so without this the second would proceed against a
   * directory the first is still cloning into. Concurrent callers AWAIT the
   * first run rather than skipping it, which is the difference between "someone
   * is preparing this" and "someone prepared this".
   *
   * Re-entrancy is handled elsewhere and deliberately: preparation's own service
   * is built with no `ensureThreadWorkspace` at all (see {@link resolveService}),
   * so its `exec` never arrives here. Were it to, awaiting the in-flight promise
   * would deadlock — the promise is waiting on that very `exec`.
   *
   * Never throws. A preparation failure must not fail the turn, and the caller
   * ({@link ThreadComputeService.ensureWorkspaceRootOnce}) already logs a throw;
   * a run that merely fell SHORT does not throw at all, and is logged here.
   *
   * BOUNDED RETRY. Preparation is withheld from the record whenever anything
   * failed, so a broken configuration is retried on the first tool call of every
   * turn — right for a clone that could not reach the network, pathological for
   * a `pnpm install` that will never succeed, which would stall every turn for
   * up to `REPOSITORY_SETUP_TIMEOUT_MS`. After {@link MAX_PREPARATION_ATTEMPTS}
   * consecutive failures with the SAME failure list, this stops attempting for
   * the rest of this DO's wake and says so. The next wake starts over, so the
   * cap can delay a recovery but can never prevent one.
   */
  private async ensureThreadWorkspacePrepared(
    threadId: string,
    prepare: () => Promise<RepositoryPreparationResult>,
  ): Promise<void> {
    const inFlight = this.preparationInFlight.get(threadId);
    if (inFlight) return inFlight;
    // The cap check lives INSIDE `run`, not between the `get` above and the
    // `set` below, and that placement is load-bearing. It awaits a D1 read, and
    // an await out here would put a suspension point between "is anyone
    // preparing this" and "I am", so two `exec`s in one turn could both miss the
    // latch and both start a preparation. Nothing between the `get` and the
    // `set` may await. Inside `run` the read is still ahead of everything else,
    // and concurrent callers await this same promise.
    const run = (async () => {
      const suspended = this.preparationFailures.get(threadId);
      if (suspended && suspended.count >= MAX_PREPARATION_ATTEMPTS) {
        // A SUSPENSION MUST NOT OUTLIVE THE CONFIGURATION THAT CAUSED IT.
        //
        // The cap is here to stop a `pnpm install` that will never succeed from
        // stalling the first tool call of every turn. It is not here to punish a
        // user who has since fixed it — and before this check it did exactly
        // that, because the skip fired before `prepare()`, so the failure key
        // could not change for the rest of the wake. D1 reads only; no exec, no
        // sandbox.
        const signature = await currentPreparationSignature(this.env, threadId);
        if (signature !== null && signature === suspended.signature) {
          // Logged at the SKIP, not only once when the cap was reached. The
          // one-shot `compute.repository_preparation_suspended` says a cap
          // happened; without this, a turn that silently did no preparation
          // looks identical to a turn that had nothing to prepare.
          log.warn("compute.repository_preparation_skipped", {
            threadId,
            consecutiveFailures: suspended.count,
          });
          return;
        }
        this.preparationFailures.delete(threadId);
      }
      const result = await prepare();
      // `failures`, not `skipped`. Nothing here throws — a skipped repository
      // and a setup command that exited non-zero are both ordinary return
      // values — which is exactly how a provider-contract mismatch left every
      // fresh agent sandbox with an empty /workspace while the logs stayed
      // clean. This log was once gated on `skipped` alone, so a repository that
      // cloned fine and whose `pnpm install` exited 2 said nothing at all.
      // `failures` is preparation's single list of everything that fell short,
      // and it is the same list that decides whether the run is recorded as
      // prepared — so what is retried and what is logged cannot diverge.
      if (result.failures?.length) {
        // The consecutive count is the diagnosable half. A failing preparation
        // is retried on the first tool call of EVERY turn — that is the trade
        // taken deliberately, because the alternative is a repository that
        // silently never arrives — but "the 4th turn in a row" is what tells an
        // operator this is a broken configuration rather than a blip, and it is
        // invisible without saying so.
        //
        // Keyed on the failures themselves, so a DIFFERENT failure restarts the
        // count: this must cap a stuck configuration, never a sequence of
        // unrelated transient ones.
        const key = result.failures.join("\u001f");
        const previous = this.preparationFailures.get(threadId);
        // A DIFFERENT configuration restarts the count as surely as a different
        // failure list does: three failures under the old setup script say
        // nothing about the new one.
        const count =
          previous?.key === key && previous.signature === result.signature ? previous.count + 1 : 1;
        this.preparationFailures.set(threadId, { key, count, signature: result.signature });
        log.warn("compute.repository_preparation_incomplete", {
          threadId,
          failures: result.failures,
          consecutiveFailures: count,
        });
        if (count >= MAX_PREPARATION_ATTEMPTS) {
          // Stop retrying for the rest of this DO wake. A 15-minute
          // `pnpm install` that will never succeed would otherwise stall the
          // first tool call of every turn, for as long as the user keeps
          // talking. The next wake tries again.
          log.warn("compute.repository_preparation_suspended", {
            threadId,
            failures: result.failures,
            consecutiveFailures: count,
          });
        }
      } else {
        this.preparationFailures.delete(threadId);
      }
    })();
    this.preparationInFlight.set(threadId, run);
    try {
      await run;
    } finally {
      this.preparationInFlight.delete(threadId);
    }
  }

  /**
   * Remove the working directories of threads that have ended, at most one pass
   * per DO instance at a time.
   *
   * WHERE THIS RUNS IS THE DESIGN. It is called from the `ensureThreadWorkspace`
   * hook — i.e. from `ensureWorkspaceRootOnce`, on the first `exec` of a turn —
   * and from NOWHERE else. That is "the next acquire" in the plan's sense: the
   * box is provisioned and awake because a user is using it, so the removal is
   * free of any wake it did not already owe.
   *
   * IT IS DELIBERATELY NOT ON THE ALARM, and this is the one place the plan and
   * the code differ. The plan's other trigger was "the alarm, if the box is
   * already awake" — but nothing here can ask whether a sprite is awake without
   * `exec`ing, which IS the wake. Since P3 the alarm's tick has NO `exec` of its
   * own at all (the cleanliness probe went with the discard inference), so an
   * alarm-side reclaim could only ever be the thing that woke a hibernated box
   * to delete a directory — the argument is stronger now, not weaker.
   * The residual is bounded and cheap: an agent that is never used again keeps
   * some directories until its box is released, which happens anyway.
   *
   * NEVER THROWS. Its caller is a hook whose throw would surface as a failed
   * `ensureWorkspaceRootOnce`, and a bookkeeping removal must not fail a user's
   * turn.
   *
   * `skipWorkspaceThreadId` is the directory the CALLING session is about to
   * work in. Removing it mid-turn would delete the cwd out from under a live
   * turn, so it is skipped and its debt is KEPT for a sibling turn to pay.
   *
   * THE SKIP IS NARROW ON PURPOSE, AND IT DOES NOT COVER BACKGROUND WORK.
   * `ThinkThreadAgent.hasActiveTurn()` is `_activeRequestId != null` and nothing
   * more, so a detached `exec_watch` or a background process is NOT a turn and
   * does not block auto-archive. A thread can therefore be archived while a
   * process of its own is still running, and the next sibling turn will
   * `rm -rf` that process's cwd out from under it while its work-ledger row is
   * still open — the row's fault reminder then being delivered to a destroyed
   * DO. That outcome is CONSISTENT with the ruling, not an oversight: the
   * removal is unconditional, so work in an archived thread is forfeit whether
   * a process is still touching it or not.
   *
   * Widening the skip to "any thread with open work" was considered and
   * REJECTED. It would reintroduce exactly the conditional the ruling removed,
   * and a leaked ledger row — the failure this whole project exists to fix —
   * would then pin a directory in the box permanently, with nothing left to
   * reclaim it. The skip covers one thing: never delete the directory the
   * session doing the deleting is standing in.
   */
  private async reclaimPendingWorkspaces(
    resolveReclaimService: () => Promise<{ service: ReclaimExecService } | null>,
    skipWorkspaceThreadId: string,
  ): Promise<void> {
    const inFlight = this.reclaimInFlight;
    if (inFlight) return inFlight;
    // Nothing may await between the read of `reclaimInFlight` above and the
    // assignment below — see `ensureThreadWorkspacePrepared` for the same rule
    // and the same reason.
    const run = (async () => {
      if (this.reclaimFailures >= MAX_RECLAIM_ATTEMPTS) return;
      const rows = await this.ctx.storage.list<number>({ prefix: PENDING_RECLAIM_PREFIX });
      const pending = [...rows]
        .map(([key, stamp]) => ({ threadId: key.slice(PENDING_RECLAIM_PREFIX.length), stamp }))
        .filter((entry) => entry.threadId !== skipWorkspaceThreadId)
        // Oldest first, so a batch cap can never starve the thread that has
        // been owed a removal longest.
        .sort((left, right) => left.stamp - right.stamp)
        .slice(0, RECLAIM_BATCH_LIMIT);
      if (pending.length === 0) return;
      const resolved = await resolveReclaimService();
      // Compute is disabled or unresolvable: there is no box to remove anything
      // from, and the rows stay for a turn that has one.
      if (!resolved) return;
      const threadIds = pending.map((entry) => entry.threadId);
      const outcome = await reclaimThreadWorkspaces({ service: resolved.service, threadIds });
      if (!outcome.ok) {
        this.reclaimFailures += 1;
        log.warn("compute.thread_workspace_reclaim_failed", {
          threadIds,
          reason: outcome.reason,
          consecutiveFailures: this.reclaimFailures,
        });
        return;
      }
      // WARN, not info, and one line per worktree. The removal is unconditional
      // by ruling, so this is the only record that a user's uncommitted or
      // unpushed work was destroyed — it is what turns "where did my work go"
      // into an answerable question.
      for (const entry of outcome.discarded) {
        log.warn("compute.thread_workspace_discarded", {
          threadId: entry.threadId,
          path: entry.path,
          changes: entry.changes,
          unpushed: entry.unpushed,
        });
      }
      if (outcome.auditTruncated) {
        log.warn("compute.thread_workspace_reclaim_audit_truncated", { threadIds });
      }
      // PER-ROOT, NOT PER-BATCH. Drop exactly the rows whose directory is now
      // gone and KEEP the rest, so one undeletable root cannot hold the whole
      // batch hostage: `pending` is sorted oldest-first, so an all-or-nothing
      // delete pinned a permanently failing root at the head of every later
      // batch and no thread on that box was ever reclaimed again.
      // CONSECUTIVE, so the cap still bounds a permanently failing `rm` to three
      // attempts per wake rather than stalling the first tool call of every
      // turn. Reset only on a pass that removed everything it asked for — a
      // partial pass DRAINED the batch, which is the fix, but the root it could
      // not remove is still a failure and must count as one.
      if (outcome.partial) {
        this.reclaimFailures += 1;
        log.warn("compute.thread_workspace_reclaim_partial", {
          requested: threadIds.length,
          removed: outcome.removed.length,
          consecutiveFailures: this.reclaimFailures,
        });
      } else {
        this.reclaimFailures = 0;
      }
      if (outcome.removed.length > 0) {
        await this.ctx.storage.delete(
          outcome.removed.map((threadId) => PENDING_RECLAIM_PREFIX + threadId),
        );
      }
    })().catch((error) => {
      this.reclaimFailures += 1;
      log.warn("compute.thread_workspace_reclaim_failed", {
        error: String(error),
        consecutiveFailures: this.reclaimFailures,
      });
    });
    this.reclaimInFlight = run;
    try {
      await run;
    } finally {
      this.reclaimInFlight = undefined;
    }
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
   * Cancel the idle-eviction schedule WITHOUT dropping a wake something still
   * needs.
   *
   * A plain `deleteAlarm()` here was a strand, and the routing fix made it a
   * worse one. `exec_shutdown` (and the recovery teardowns) stop every process
   * on the box, terminalize each row on its OWNER's ledger, and deliberately
   * withhold the delivery stamp for owners the caller never spoke to — on the
   * promise that the owner's own sweep will report it. That sweep has exactly
   * one trigger: `sweepSandboxWorkLedger`, called only from this DO's
   * `alarm()`. Deleting the alarm one line later removed the only thing that
   * could keep the promise, so the owner's row sat open and unread until some
   * other thread of the agent happened to do compute and re-arm.
   *
   * So: cancel, then ask the ROSTER whether anything is still owed or open, and
   * re-arm for that. The roster fold is affordable here for the same reason it
   * is in {@link rosterHasBlockingWork} — this is a teardown, not a per-exec
   * path. If nothing is owed the box is left with no alarm, exactly as before.
   *
   * The horizon is armed unclamped, matching the ledger component of
   * `runSandboxComputeAlarm`'s fallback: an open row whose horizon is already
   * past means the sweep is overdue, and the next alarm is what closes it.
   */
  private async cancelEvictionKeepingOwedWork(now: number): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    // The CALLER's clock, threaded the whole way. This is the third
    // arm-adjacent fold of the roster and it was the only one omitting `now` —
    // correct in production solely because `resolveComputeService` defaults
    // `deps.now` to `Date.now()`, i.e. by coincidence rather than by
    // construction, which is precisely the shape `getSandboxWorkHorizon`'s doc
    // warns about.
    const horizon = await this.rosterWorkHorizon(now);
    if (horizon !== null) await this.ctx.storage.setAlarm(horizon);
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
   * AND CONSERVATISM HAS A PRICE HERE, which the fan-out multiplies by N. That
   * `true`-on-unreachable is what blocks `releaseIfIdle`, so ONE transiently
   * unreachable rostered thread now keeps the WHOLE box alive rather than just
   * its own; on a provider with no auto-destroy the sprite bills for as long as
   * it lasts. Worse, a roster entry is only pruned by a sweep that REACHES its
   * thread, so a permanently unreachable one pins the box awake indefinitely.
   * That trade is deliberate — destroying a container out from under a live
   * child loses work, and work outranks money in this codebase — but it is a
   * trade, not a free win, and it is stated so nobody has to rediscover the
   * bill. The bounded fix is a reachability-preserving probe (the shape
   * `probeWorkHorizon` already uses for the roster prune) so a sibling's
   * SILENCE and a sibling's YES can be priced differently; that needs its own
   * task, because it decides when it is acceptable to reclaim a box whose
   * child we cannot ask about.
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
      /**
       * Whose working directory. Required on every path, never defaulted to
       * `threadId` — see `ComputeServiceHostDeps.workspaceThreadId`.
       */
      workspaceThreadId: string;
      /**
       * Whether this service may PREPARE the thread's working directory —
       * clone, add worktrees, run setup commands — on its first command.
       *
       * REQUIRED, stated at both call sites, because the wrong answer changes
       * behaviour without failing anything. `true` for a turn's session: that
       * is the whole point of the per-thread trigger. `false` for the ALARM.
       *
       * The alarm's tick reaches `exec` on a service whose latch is fresh, so
       * it would otherwise run a full preparation inside an alarm handler
       * whenever the agent's configuration had changed since the last turn — a
       * `git clone` plus a setup script, for a box nobody is using, on the very
       * path that is deciding whether to RELEASE it. (Until P3 it was worse
       * still: the idle decision read a cleanliness probe afterwards, so a setup
       * script writing one untracked file flipped a discardable box into a
       * preserved one. That inference is gone — the box is always preserved —
       * but running a clone from an alarm is no less wrong for it.)
       *
       * Withholding it does not leave the alarm without a working directory:
       * `ensureWorkspaceRootOnce` still creates `/workspace` and the thread's
       * own directory. Only the repository work is withheld, and the next turn
       * does it.
       */
      prepareWorkspace: boolean;
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
    // Preparation runs on a SECOND service, and that is not an oversight — the
    // caller's own service DEADLOCKS.
    //
    // `ensureThreadWorkspace` fires from `ensureWorkspaceRootOnce`, which every
    // `exec` goes through and which now AWAITS the provisioning promise it is
    // itself settling (see `ThreadComputeService.workspaceReady`; a second
    // concurrent exec must wait for the clone rather than race it). Preparation
    // runs `exec`. On the caller's service that exec would await the promise
    // that is waiting on the exec, and nothing would ever settle it.
    //
    // The second service is built with EMPTY hooks — `buildService(..., {})` —
    // so it carries no `ensureThreadWorkspace` at all and the shape cannot
    // close. That omission is the mechanism, not a tidiness choice.
    //
    // It is not the re-entrancy the plan feared, either: `resolveComputeService`
    // is a plain function call in this same isolate. There is no RPC, so there
    // is no second trip through this DO's input lock. And its
    // `acquisitionInFlight` is undefined while the store already says `active`,
    // so its `readOrAcquireRuntime` returns at once rather than acquiring
    // anything of its own.
    //
    // The reclaim shares it, for exactly the same reason: it runs from the same
    // hook, on the same `exec` path, and a reclaim issued on the caller's
    // service would await the promise its own exec is settling.
    const resolveHookService = async () => {
      const prepared = await this.buildService(threadId, options, {});
      return prepared ? { service: prepared.service } : null;
    };
    const prepareRepositories = createRepositoryPreparation({
      env: this.env,
      threadId,
      resolveComputeService: resolveHookService,
    });
    return await this.buildService(threadId, options, {
      // NO `onFreshRuntimeAcquired`. It used to carry repository preparation,
      // and that was the whole of H1: it fires only on `absent -> active`, and
      // the compute store is the AGENT's, so it fires once per BOX. Thread A
      // woke the sprite and got its worktree; every later thread of the same
      // agent reached an already-active runtime, ran no preparation at all, and
      // got a working directory that existed and was empty.
      //
      // It then briefly carried the invalidation of a DO-storage "prepared"
      // marker, and that was H1 again by another route: the marker survived a
      // reclaim of the thread's directory, so a reopened thread read as prepared
      // and worked in the empty directory `ensureWorkspaceRootOnce` had just
      // recreated. The record now lives INSIDE the thread's directory
      // (`createRepositoryPreparation`), where every event that destroys the
      // preparation destroys the record with it — so there is nothing left for
      // a fresh-acquire hook to invalidate.
      //
      // THE RECLAIM RIDES THE SAME GATE, and that is not incidental. It is
      // `prepareWorkspace` that says "this service belongs to a turn, on a box
      // a user is already using"; the ALARM's service says the opposite, and a
      // reclaim there would be the thing that woke a hibernated sprite to
      // delete a directory. See {@link reclaimPendingWorkspaces}.
      //
      // BEFORE preparation, so the disk a clone and a setup script are about to
      // need is freed first. Either order is CORRECT — the reclaim only touches
      // roots of threads that have ended, and `worktree prune` removes only
      // registrations whose directory is already gone — so this is a preference,
      // not an invariant.
      //
      // ACCEPTED, UNBOUNDED DEBT, RECORDED HERE BECAUSE IT IS RECORDED NOWHERE
      // ELSE: this hook is the ONLY thing that pays reclaim debt, and it runs
      // only on a turn. An agent whose threads are ALL archived therefore
      // accrues `/workspace/threads/*` forever — nothing wakes the box to
      // collect it, and its disk grows with every retired thread until the
      // agent is deleted. That follows directly from the never-wake-a-hibernated
      // -sprite-to-delete-a-directory ruling and is the price of it, not an
      // oversight. It compounds with the phase's other accepted disk debt (a
      // removed repository's canonical clone lingers, per the spec) and neither
      // has a bound. Anything that reclaims this has to answer the question the
      // ruling settled: what makes waking a box worth the bill.
      ...(options.prepareWorkspace
        ? {
            ensureThreadWorkspace: async () => {
              await this.reclaimPendingWorkspaces(resolveHookService, options.workspaceThreadId);
              await this.ensureThreadWorkspacePrepared(threadId, prepareRepositories);
            },
          }
        : {}),
    });
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
      /** See {@link resolveService}'s option of the same name. */
      workspaceThreadId: string;
      supportsProcessMonitor: boolean;
      purpose?: ComputeResolvePurpose;
      attachedRuntime?: BackendReference;
      runtimeConfig?: { workspaceId: string; agentId: string };
      /** See {@link resolveService}'s option of the same name. */
      workHorizon: "resolving-thread" | "roster";
    },
    hooks: {
      /**
       * Omitted for the service repository preparation runs ON — see
       * {@link resolveService}. Its absence is what makes preparation's own
       * `exec` non-re-entrant, so this is load-bearing, not a convenience.
       */
      ensureThreadWorkspace?: ComputeServiceHostDeps["ensureThreadWorkspace"];
    },
  ) {
    const host = this.threadHostDeps(threadId);
    return resolveComputeService({
      env: this.env,
      threadId,
      workspaceThreadId: options.workspaceThreadId,
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
      cancelEviction: (now) => this.cancelEvictionKeepingOwedWork(now),
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
      // Required on `ComputeServiceHostDeps`, so the no-op has to be spelled
      // out here rather than omitted — and spelling it out is the point: a
      // service built without preparation says so.
      ensureThreadWorkspace: hooks.ensureThreadWorkspace ?? (async () => {}),
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
    /**
     * The thread whose working directory this session works in. REQUIRED and
     * never inferred: a `SubAgent`'s `threadId` is a run id, and it works inside
     * its PARENT's checkout. Inferring would give every subagent an empty
     * directory of its own — created, never populated, and silent.
     */
    workspaceThreadId: string;
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
        workspaceThreadId: input.workspaceThreadId,
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
        workspaceThreadId: input.workspaceThreadId,
        // A turn. This is the trigger every thread of the box reaches.
        prepareWorkspace: true,
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
   * A thread has ENDED — archived or deleted — so this box owes the removal of
   * its working directory. Records the debt; removes nothing.
   *
   * NO `exec`, NO alarm, NO wake. That is the whole method: the removal happens
   * on the next turn that has this box awake anyway (see
   * {@link reclaimPendingWorkspaces}). Arming an alarm here would defeat it —
   * auto-archive is a cron over many idle threads, and an alarm per archived
   * thread would wake every idle agent's box to delete a directory nobody is
   * waiting on.
   *
   * A box that has never opened a session records NOTHING. `ALARM_PARAMS_KEY` is
   * written before the resolve on every `session()` open, so its absence proves
   * no session has ever run here, and a box no session has run on cannot have a
   * `/workspace/threads/<id>` to remove. Without that check, archiving a thread
   * of a compute-less agent would create — and permanently populate — a Durable
   * Object that nothing else would ever read.
   *
   * IDEMPOTENT: a repeated call rewrites one row. Archive is terminal (there is
   * no unarchive path) and delete is final, so the debt is never withdrawn.
   */
  async releaseThreadWorkspace(input: { threadId: string }): Promise<SandboxCallResult<null>> {
    try {
      if ((await this.ctx.storage.get(ALARM_PARAMS_KEY)) === undefined) {
        return { ok: true, value: null };
      }
      await this.ctx.storage.put<number>(PENDING_RECLAIM_PREFIX + input.threadId, Date.now());
      return { ok: true, value: null };
    } catch (error) {
      log.warn("agent_sandbox.release_thread_workspace_failed", {
        threadId: input.threadId,
        error: String(error),
      });
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
  /**
   * Put this agent's box to sleep so another agent in the workspace can have
   * the slot. Returns true only if a box was actually released.
   *
   * Addressed to the AGENT, because the machine is the agent's — the quota gate
   * calls this directly rather than through some thread that happens to be
   * rostered. There is no per-thread caller and no caller-supplied identity: it
   * replays the LAST recorded session, exactly as the alarm does, so a box that
   * has never opened one simply refuses.
   *
   * `prepareWorkspace: false`, for the alarm's reason: this decides whether to
   * RELEASE a box nobody is using, and a preparation here would be the thing
   * that woke it.
   *
   * NEVER DESTROYS. `releaseIfReclaimable` takes the recoverable disposition
   * unconditionally, so the worst case is a hibernated sprite, disk intact.
   */
  async releaseIfReclaimableForAgent(): Promise<boolean> {
    const params = (await this.ctx.storage.get<SandboxAlarmParams>(ALARM_PARAMS_KEY)) ?? null;
    if (!params) {
      log.info("agent_sandbox.reclaim_without_recorded_session", {
        agentId: this.ctx.id.name ?? "unknown",
      });
      return false;
    }
    try {
      const resolved = await this.resolveService(params.threadId, {
        workspaceThreadId: params.workspaceThreadId ?? params.threadId,
        prepareWorkspace: false,
        supportsProcessMonitor: params.supportsProcessMonitor,
        runtimeConfig: params.runtimeConfig,
        // A DISABLED agent's box must still be reachable to be put to SLEEP.
        // Without this the resolve returns null, `markIdle` never runs, and the
        // row pins `active` forever: `listReclaimCandidates` keeps offering an
        // agent whose reclaim can only refuse, and the workspace loses a slot
        // per disabled agent until each is deleted. A reclaim can never
        // destroy, which is what makes lifting the gate safe here.
        purpose: "reclaim",
        workHorizon: "roster",
        ...(params.attachedRuntime ? { attachedRuntime: params.attachedRuntime } : {}),
      });
      if (!resolved) return false;
      return await resolved.service.releaseIfReclaimable();
    } catch (error) {
      // A refusal, never a throw: the caller races this against a timeout and
      // treats any non-`true` as "try the next candidate".
      log.warn("agent_sandbox.reclaim_failed", {
        agentId: params.runtimeConfig.agentId,
        error: String(error),
      });
      return false;
    }
  }

  /**
   * DESTROY this agent's machine. One of exactly two paths that may (the other
   * is the orphan reconciler), and it exists because agent deletion had no way
   * to reach the box at all.
   *
   * The route used to walk the agent's NON-ARCHIVED threads and shut each one's
   * sandbox down. Under agent keying that is wrong twice over: an agent whose
   * threads are all archived has no thread to walk and its box was left
   * stranded, billing forever; and any one thread's `execShutdown` was already
   * destroying the shared machine, so the walk was N attempts at one machine.
   *
   * `purpose: "teardown"` because the caller is DELETING the agent: the
   * `enabled === false` / `archived_at` gates must not turn "you may not work
   * here" into "your machine is undeletable".
   *
   * Returns why it did nothing, so a teardown that decides to do nothing says
   * so — the failure mode this route already learned the hard way.
   */
  async destroyForAgentDeletion(input: {
    workspaceId: string;
    agentId: string;
  }): Promise<{ destroyed: boolean; reason?: string }> {
    const params = (await this.ctx.storage.get<SandboxAlarmParams>(ALARM_PARAMS_KEY)) ?? null;
    // The recorded session names a thread whose DO can take the back-calls the
    // teardown makes. Falling back to the agent id would address a thread DO
    // that does not exist — the trap Task 1 removed from the alarm, and it is
    // the same trap here.
    if (!params) return { destroyed: false, reason: "no_recorded_session" };
    const resolved = await this.resolveService(params.threadId, {
      workspaceThreadId: params.workspaceThreadId ?? params.threadId,
      prepareWorkspace: false,
      supportsProcessMonitor: params.supportsProcessMonitor,
      runtimeConfig: { workspaceId: input.workspaceId, agentId: input.agentId },
      purpose: "teardown",
      workHorizon: "roster",
    });
    if (!resolved) return { destroyed: false, reason: "compute_disabled" };
    const result = await resolved.service.execShutdown({ confirm: true });
    if (!result.terminated) {
      return {
        destroyed: false,
        reason: "alreadyGone" in result ? "already_gone" : "needs_confirmation",
      };
    }
    return { destroyed: true };
  }

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
          workspaceThreadId: params.workspaceThreadId ?? params.threadId,
          // NOT the alarm's job — see the option's doc. The tick issues no
          // model commands.
          prepareWorkspace: false,
          supportsProcessMonitor: params.supportsProcessMonitor,
          runtimeConfig: params.runtimeConfig,
          // The tick is what RELEASES an idle box, so it needs the same lift as
          // the reclaim RPC: a disabled agent's box would otherwise never reach
          // `releaseIfIdle`, and its ledger row would never go `idle`. This is
          // also what makes the slot free itself one idle timeout after the
          // disable, instead of only under cap pressure.
          purpose: "reclaim",
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
