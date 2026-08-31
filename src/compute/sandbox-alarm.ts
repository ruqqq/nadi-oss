import { log } from "../log";
import { DEFAULT_MONITOR_POLL_INTERVAL_MS } from "./watchers";

/**
 * The slice of `ThreadComputeService` the alarm drives.
 *
 * Named structurally, and this whole module extracted out of the DO, because it
 * is the ordering-critical half of `AgentSandbox.alarm()`: the suite that pins
 * that ordering (`test/unit/agent/alarm-rearm.test.ts`) drives a REAL
 * `ThreadComputeService` and a real sweep, and would otherwise have to stand up
 * a Durable Object instance to reach a decision that depends on neither.
 */
export interface SandboxAlarmComputeService {
  alarmArmCount(): Promise<number>;
  runComputeTick(): Promise<void>;
  isComputeLive(): Promise<boolean>;
  nextWatcherWakeAt(): Promise<number | null>;
  now(): Promise<number>;
}

/**
 * What the alarm needs from the DO around it. `S` is the whole resolution the
 * host opened, threaded back into {@link SandboxAlarmHost.sweepWorkLedger}
 * untouched so the host can marshal it however it must (the sandbox DO sends
 * the session across RPC to the thread DO that owns the ledger).
 */
export interface SandboxAlarmHost<S extends { service: SandboxAlarmComputeService }> {
  threadId: string;
  /**
   * Resolve THIS invocation's compute session. `null` = compute is disabled for
   * the thread; a THROW = resolution failed. The two are different downstream —
   * see `sweepWorkLedger`.
   *
   * Opened here, inside the invocation that uses it, and never held across one:
   * an alarm is a new invocation, so it may reuse nothing.
   */
  openSession(): Promise<S | null>;
  /**
   * Run the thread DO's work-ledger sweep. `undefined` means "resolution never
   * completed — resolve independently"; `null` means "compute is disabled, do
   * not resolve". That distinction is `runWorkLedgerSweep`'s own contract and is
   * preserved across the wire.
   */
  sweepWorkLedger(session: S | null | undefined): Promise<void>;
  /** The thread DO's ledger horizon at `now` (open rows + an owed retry wake). */
  workHorizon(now: number): Promise<number | null>;
  /** Arm this sandbox's single alarm. */
  setAlarm(timestampMs: number): Promise<void>;
  /** Clear the "workspace verified clean" bit on the owning thread. */
  setSandboxDeclaredClean(clean: boolean): Promise<void>;
}

/**
 * The compute alarm. Runs on `AgentSandbox`'s OWN `alarm()`: the sandbox owns
 * the machine, so it owns the machine's tick. When compute is disabled for the
 * thread the tick is skipped entirely (nothing is deleted), but the work-ledger
 * sweep below still runs — the ledger outlives the compute service by design,
 * since closing rows is exactly what must keep happening when the sandbox is
 * gone. That is also why the sweep is a back-call rather than a move: the
 * ledger spans SUBAGENT rows and its reaper lives on the thread DO.
 *
 * ONE ALARM, NOT TWO. The sweep keeps running on the thread DO — its code, its
 * DO, its ledger — but it is TRIGGERED from here, chained after the tick inside
 * this single invocation. Two independent alarms cannot hold the ordering below:
 * nothing would sequence them, and the sweep would routinely classify against
 * the previous tick's stamps. See the report for Task 9.
 *
 * Re-arming is the compute service's job, not this function's: the ledger's
 * horizon is min-folded into `armAlarm` via the `getWorkHorizon` dep, so one
 * alarm serves eviction, watcher polls and the sweep. This arms only as a
 * FALLBACK, gated on the fact that nothing else armed (see below).
 *
 * ORDER IS LOAD-BEARING: resolve -> tick -> sweep -> fallback. The tick must
 * run BEFORE the sweep, and this has now been broken three times — do not
 * "optimize" it back.
 *
 * The tick polls processes and stamps `lastAliveAt`; the sweep classifies rows
 * against those stamps. Sweeping first classifies staleness from the PREVIOUS
 * tick's stamps, one line before the tick would refresh them. The
 * `PROCESS_STALE_AFTER_MS` is 3x the poll interval, so an alarm two poll
 * intervals late — or that long spent inside `resolveComputeService` (a GitHub
 * token mint plus several D1 reads) — would fault a HEALTHY, still-running
 * process as `no_liveness`. The reaper must never false-positive: a false fault
 * is worse than the hang this project exists to fix.
 *
 * The accepted cost of tick-first is one spurious wake: the tick's `armAlarm`
 * folds `getWorkHorizon` over pre-sweep rows, so a row the sweep is about to
 * close can contribute a stale (possibly immediate) horizon — at most ONE extra
 * immediate wake per stale event, self-limiting because that same pass closes
 * the row and the next arm is correct. Every alternative is worse: sweeping
 * first re-opens the false-fault channel above; re-arming after the sweep would
 * CANCEL and overwrite the tick's nearer alarm (the round-3 Critical); clamping
 * the horizon would hide real staleness.
 */
export async function runSandboxComputeAlarm<S extends { service: SandboxAlarmComputeService }>(
  host: SandboxAlarmHost<S>,
): Promise<void> {
  const threadId = host.threadId;
  // The alarm fires outside any turn, so an unregistered thread or any
  // resolution error would otherwise surface as an uncaught rejection in the
  // alarm handler. Swallow + log.
  //
  // `resolved` is threaded into the sweep below so it does not re-resolve
  // (several D1 reads plus a GitHub App token mint) a second time in the same
  // tick. Left `undefined` if resolution itself never completed — the sweep
  // then falls back to its own independent resolve, isolated from whatever
  // failed here.
  let resolved: S | null | undefined;
  // The FACT the fallback below gates on: did anything actually arm this pass?
  // Never inferred from "the tick did not throw" — a tick can throw after
  // arming (fallback would then overwrite a nearer alarm) and can return
  // without arming at all (fallback must run).
  let armed = false;
  try {
    resolved = await host.openSession();
  } catch (error) {
    log.warn("agent_sandbox.alarm_resolve_failed", { threadId, error: String(error) });
  }
  // Own guard: a tick failure must not skip the sweep or the fallback arm below
  // — that is the whole point of sampling `alarmArmCount`.
  if (resolved) {
    const service = resolved.service;
    const armCountBefore = await service.alarmArmCount();
    try {
      await service.runComputeTick();
      // Backstop: once the environment is gone, any prior "clean" claim no
      // longer applies to it.
      if (!(await service.isComputeLive())) {
        await host.setSandboxDeclaredClean(false);
      }
    } catch (error) {
      log.warn("agent_sandbox.alarm_tick_failed", { threadId, error: String(error) });
    } finally {
      armed = (await service.alarmArmCount()) > armCountBefore;
    }
  }
  // Own guard: a sweep failure must never prevent the compute tick above from
  // having run, and must never surface as an uncaught rejection in the alarm
  // handler. Runs AFTER the tick so it classifies against fresh liveness stamps
  // — see the doc comment above; this ordering is not negotiable, and the
  // late-alarm test in alarm-rearm.test.ts fails if it is reverted.
  try {
    await host.sweepWorkLedger(resolved);
  } catch (error) {
    log.warn("agent_sandbox.alarm_sweep_failed", { threadId, error: String(error) });
  }
  // Fallback re-arm, outside every guard above. The tick's `armAlarm` is the
  // sandbox's one arm site and min-folds the ledger horizon, so when it armed
  // there is nothing to add: a Durable Object has ONE alarm, so arming here
  // would REPLACE the tick's (nearer) alarm and stretch the watcher poll out to
  // the ledger's later horizon.
  //
  // When nothing armed — compute disabled or unresolved, the tick threw (e.g.
  // an unguarded D1 quota write), or the tick exited without arming (state
  // `acquiring`/`releasing`/`discarding` falls through `releaseIfIdle` early) —
  // nothing else will ever wake this sandbox, and an open row would never be
  // swept again. That is the original bug this project exists to kill, so this
  // branch is not optional.
  //
  // The horizon covers open WORK, not just open ledger rows (invariant B is
  // "never strand open work"). A live watcher whose row is already closed is
  // invisible to `listOpen()` — reachable, since terminal-first closes the row
  // while a `deliverSystemReminder` throw skips `deleteWatcher` — so fold in the
  // watchers' next poll too, or that watcher never polls again.
  // `nextWatcherWakeAt` is a read-only store read: no backend call, so it keeps
  // the fallback's load-bearing property of never blocking on a dead sandbox.
  //
  // The horizon also covers rows that are terminal-but-OWED (`workHorizon` folds
  // them in), and this is the one arm site that must: the sweep directly above
  // is what leaves a row owed — its delivery throws, the row is already closed,
  // and `listOpen()` goes empty. On a thread with no watcher and no other open
  // row that is the whole wake source, and without it the retry pass can never
  // run again.
  //
  // The ledger-row component needs no floor: the sweep above closed every
  // non-alive row in this same pass, and an `alive` row's horizon
  // (min(deadlineAt, lastAliveAt + staleAfterMs)) is by definition >= now. The
  // owed component needs none either — it is `now + WORK_DELIVERY_RETRY_MS`.
  //
  // The watcher component DOES need a floor. `nextPollAt` only advances inside
  // `pollDueWatchers`, which runs from `runComputeTick` above, AFTER the
  // unguarded `quota.refresh()` D1 write. This fallback is reached precisely
  // when that tick did NOT run to completion — i.e. exactly when `nextPollAt`
  // was NOT stamped forward. Unlike a ledger row, nothing closes or advances a
  // watcher when the tick throws before polling, so a `nextPollAt` already due
  // can stay pinned in the past indefinitely, re-arming the alarm hot
  // (immediate refire, paying a full `resolveComputeService` each time) for as
  // long as the write keeps failing. Only clamp when it is actually stuck in the
  // past — a watcher due soon but still ahead of `now` is a normal near-term
  // wake and must fire on schedule, not be pushed out to a full poll interval.
  if (armed) return;
  try {
    const rawWatcherHorizon = (await resolved?.service.nextWatcherWakeAt()) ?? null;
    const now = (await resolved?.service.now()) ?? Date.now();
    const workHorizon = await host.workHorizon(now);
    const watcherHorizon =
      rawWatcherHorizon === null
        ? null
        : rawWatcherHorizon <= now
          ? now + DEFAULT_MONITOR_POLL_INTERVAL_MS
          : rawWatcherHorizon;
    const horizon =
      workHorizon === null || (watcherHorizon !== null && watcherHorizon < workHorizon)
        ? watcherHorizon
        : workHorizon;
    if (horizon !== null) await host.setAlarm(horizon);
  } catch (error) {
    log.warn("agent_sandbox.alarm_rearm_failed", { threadId, error: String(error) });
  }
}
