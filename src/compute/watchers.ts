/**
 * Pure logic for the compute process-watcher registry (no I/O). A "watcher"
 * tracks one compute process the model asked to be notified about: it is
 * polled until the process exits or a deadline passes, at which point a
 * proactive reminder fires (see later tasks — this module only decides
 * when and whether to fire, not how).
 */

/** Hard cap on the number of watchers a single thread may register at once. */
export const MAX_WATCHERS_PER_THREAD = 8;

/**
 * Hard cap on the watchers ONE BOX polls, across every thread of the agent.
 *
 * The per-thread cap alone stopped bounding the tick when P3 made the box
 * agent-scoped: N threads at 8 each is 8N backend polls every
 * {@link DEFAULT_MONITOR_POLL_INTERVAL_MS}. The per-thread cap is now about
 * FAIRNESS (one conversation cannot starve its siblings) and this one is about
 * LOAD. Both are needed; neither substitutes for the other.
 */
export const MAX_WATCHERS_PER_BOX = 32;

/**
 * Why a watcher was refused, or `"ok"`.
 *
 * A reason, not a boolean, because the caller has to SAY it: the old
 * `canAddWatcher` returned false and `backgroundResult` silently degraded to
 * "running in the background without a watcher" with no explanation, so one
 * busy thread could deny every sibling its completion cards and the only trace
 * was a missing sentence.
 */
export type WatcherAdmission = "ok" | "thread_limit" | "box_limit";

/**
 * Poll cadence for watched processes, in milliseconds.
 *
 * Was 7s when the poll WAS the delivery mechanism for a background process's
 * completion. It no longer is: the sandbox wrapper pushes completion straight
 * to `POST /api/compute/completion` on both remaining providers (sprites,
 * Cloudflare), so this poll's only job now is to catch a lost callback and to
 * re-assert a hold the sandbox may have dropped (see `pollWatcher` in
 * `thread-service.ts`). 60s reflects that demotion.
 *
 * `PROCESS_STALE_AFTER_MS` (agent/work-ledger.ts) is DERIVED from this value
 * (3x), not restated, precisely so the two cannot drift apart again — a
 * widened poll against the old fixed threshold faulted every backgrounded
 * process one poll after it started.
 */
export const DEFAULT_MONITOR_POLL_INTERVAL_MS = 60_000;

export interface WatcherRow {
  processId: string;
  /**
   * The thread this watcher answers to — where its completion reminder is
   * delivered and whose work ledger holds its row.
   *
   * REQUIRED, so a writer cannot acquire the wrong routing by omission: since
   * P3 one box serves every thread of the agent, and the watcher registry is
   * per-BOX. `null` is the explicit "row predates the stamp" value, resolved
   * by the reader to the thread currently resolving the service — never a
   * writer's shortcut for "whatever thread you like".
   */
  threadId: string | null;
  deadlineAt: number;
  pollIntervalMs: number;
  nextPollAt: number;
  label: string | null;
  createdAt: number;
}

/**
 * Terminal process statuses — anything that isn't `"running"`. Mirrors the
 * `ComputeProcessStatus` union in `./thread-store.ts` (`"running" | "exited" |
 * "failed" | "stopped"`), duplicated here (rather than imported) to keep this
 * module free of dependencies on the store's I/O-adjacent types.
 */
type ProcessStatus = "running" | "exited" | "failed" | "stopped";

function isTerminalStatus(status: ProcessStatus): boolean {
  return status !== "running";
}

export type WatcherClassification = "exited" | "timeout" | "renew" | "pending";

/**
 * Last-resort cap on how long a single watcher may keep renewing itself for a
 * still-running process before it is abandoned. Without this, a wedged
 * process would be renewed forever. Generous (1h) because the point is to
 * guarantee completion notifications for normal long-running commands, not to
 * second-guess how long a command should take.
 *
 * Same numeric value as `MAX_WATCH_TIMEOUT_MS` in thread-service.ts (also 1h)
 * — that's a coincidence, not a shared knob. This one is a separate,
 * dependency-free constant; don't assume tuning one affects the other.
 */
export const WATCH_ABSOLUTE_TIMEOUT_MS = 3_600_000;

/**
 * Decides what a watcher should do on this poll: fire because the process
 * already exited, abandon because the absolute cap passed, renew because the
 * (renewable) deadline passed but the process is still running, or keep
 * waiting. Exit takes precedence over everything — a process that finished by
 * its deadline is reported as "exited", never "timeout" or "renew".
 */
export function classifyWatcher(input: {
  watcher: WatcherRow;
  processStatus: ProcessStatus;
  now: number;
}): WatcherClassification {
  const { watcher, processStatus, now } = input;
  if (isTerminalStatus(processStatus)) return "exited";
  if (now >= watcher.createdAt + WATCH_ABSOLUTE_TIMEOUT_MS) return "timeout";
  if (now >= watcher.deadlineAt) return "renew";
  return "pending";
}

/**
 * The next time the thread's alarm should fire: the earliest of the compute
 * environment's own release time, every watcher's next poll time, and the
 * background work ledger's sweep horizon. Returns `null` only when there is
 * nothing to wake up for (no watchers, no pending eviction, no open work).
 *
 * This is the thread's SINGLE arm point, and it must stay a true min-fold: the
 * underlying scheduler is cancel-then-set on one stored id, so any second
 * caller arming its own alarm silently cancels this one. A later horizon
 * folded in here can only be ignored; armed separately it would DELAY the
 * watcher poll it overwrote (a healthy cadence became 3x that way — the
 * reason `workHorizon` is a parameter rather than a second `setAlarm` call).
 *
 * `workHorizon` stays a plain number so this module keeps no dependency on the
 * ledger's types; the caller computes it via `nextSweepAt` (agent/work-ledger.ts).
 */
export function nextWakeAt(
  watchers: WatcherRow[],
  evictAt: number | null,
  workHorizon: number | null = null,
): number | null {
  let min = evictAt;
  if (workHorizon !== null && (min === null || workHorizon < min)) min = workHorizon;
  for (const watcher of watchers) {
    if (min === null || watcher.nextPollAt < min) min = watcher.nextPollAt;
  }
  return min;
}

/**
 * Whether another watcher may be registered, and if not, WHICH cap refused it.
 *
 * BOTH counts are required — the box-wide one cannot be derived from the
 * thread's, and a caller that passed only what it had to hand would silently
 * restore the pre-P3 behaviour.
 */
export function admitWatcher(input: {
  /** Watchers already held by the thread that will OWN the new one. */
  threadCount: number;
  /** Watchers already held by every thread of this box, the new owner included. */
  boxCount: number;
}): WatcherAdmission {
  // BOX FIRST, and the order is diagnostic rather than behavioural. A full box
  // admits nothing whoever owns the row, so reporting `thread_limit` for a row
  // whose owner merely also happens to be at eight tells the reader — and the
  // `compute.auto_watch_refused` log line — that ONE conversation is busy when
  // the truth is the whole agent is saturated. That is the wrong first move in
  // the only incident where this line matters.
  //
  // Round 1 ordered these the other way round to make the refusal MESSAGE
  // actionable ("unwatch one of yours"). Round 2 deleted that advice — there is
  // no `exec_unwatch` tool to act on — so nothing is left arguing for
  // thread-first, and the caller's `continue`/`break` choice reads correctly
  // too: `box_limit` ends the walk, which a saturated box should.
  if (input.boxCount >= MAX_WATCHERS_PER_BOX) return "box_limit";
  if (input.threadCount >= MAX_WATCHERS_PER_THREAD) return "thread_limit";
  return "ok";
}
