/**
 * Pure logic for the compute process-watcher registry (no I/O). A "watcher"
 * tracks one compute process the model asked to be notified about: it is
 * polled until the process exits or a deadline passes, at which point a
 * proactive reminder fires (see later tasks — this module only decides
 * when and whether to fire, not how).
 */

/** Hard cap on the number of watchers a single thread may register at once. */
export const MAX_WATCHERS_PER_THREAD = 8;

/** Default poll cadence for watched processes, in milliseconds. */
export const DEFAULT_MONITOR_POLL_INTERVAL_MS = 7000;

export interface WatcherRow {
  processId: string;
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
 * watcher poll it overwrote (a healthy 7s cadence became 21s that way — the
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

/** Whether another watcher can be registered given the current count. */
export function canAddWatcher(currentCount: number): boolean {
  return currentCount < MAX_WATCHERS_PER_THREAD;
}
