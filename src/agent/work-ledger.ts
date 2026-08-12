/**
 * Pure logic for the background work ledger (no I/O). One row tracks one unit
 * of background work — a watched compute process or a subagent run — and this
 * module decides only whether that work is alive, stale, expired, or faulted.
 *
 * The enforcement property lives in the caller (the reaper): classification
 * reads the row, never the backend, so a dead sandbox cannot wedge the sweep.
 *
 * This module is deliberately dependency-free of anything I/O-adjacent — see
 * `ProcessStatus` below, duplicated from the store's type rather than
 * imported. `DEFAULT_MONITOR_POLL_INTERVAL_MS` is the one exception: it comes
 * from `compute/watchers.ts`, which is equally pure (no imports of its own,
 * so pulling it in here creates no cycle), and importing it is exactly what
 * keeps `PROCESS_STALE_AFTER_MS` from drifting off the cadence it is defined
 * against.
 */
import { DEFAULT_MONITOR_POLL_INTERVAL_MS } from "../compute/watchers";

/**
 * Silence threshold for a watched process: 3x the watcher poll interval.
 * Derived, not restated — see this module's doc comment for why the import is
 * safe, and `DEFAULT_MONITOR_POLL_INTERVAL_MS`'s own doc for why 3x matters
 * (a poll widened without this moving in lockstep faults every backgrounded
 * process one poll after it starts).
 *
 * Stored per row at registration (`buildProcessWorkRow`), so a change here
 * only affects NEW rows — existing open rows keep whatever threshold they
 * were registered with. That is a deliberate, accepted gap: no migration
 * exists or is needed, since an open row's own `staleAfterMs` is exactly the
 * value `classifyWork` uses for it (see `WorkRow.staleAfterMs`).
 */
export const PROCESS_STALE_AFTER_MS = DEFAULT_MONITOR_POLL_INTERVAL_MS * 3;

/**
 * Silence threshold for a subagent run. A child step can legitimately be a long
 * silent model call or build, so the child heartbeats while a turn is in flight
 * (`startLiveness` in subagent.ts) rather than stamping at step boundaries;
 * 3 minutes of ZERO stamps means nothing is turning the child's event loop.
 *
 * Be precise about what a heartbeat proves: it is a timer, so it shows the
 * child's isolate is alive and its turn has not settled — NOT that the work is
 * progressing. A child that hangs while its event loop keeps turning still
 * stamps; that case is bounded by `deadlineAt`, not by this window. A sandbox
 * reset is caught earlier still, by the generation check `classifyWork`
 * evaluates BEFORE liveness. This is still strictly better than the SDK's
 * model-reported no-progress timer (disabled via `noProgressBudgetMs: Infinity`
 * in subagent-config.ts), which faulted healthy long silent work.
 */
export const SUBAGENT_STALE_AFTER_MS = 180_000;

/** Hard cap for a subagent run; mirrors `maxBudgetMs` in subagent-config.ts. */
export const SUBAGENT_DEADLINE_MS = 45 * 60_000;

/**
 * How long a delivered terminal row is kept. This is a CORRECTNESS floor, not
 * a tuning knob: a pruned id that is later re-registered comes back as a
 * fresh OPEN row and gets faulted `no_liveness` ~21s later — a false fault on
 * work that already ended cleanly. 24h comfortably exceeds every live horizon
 * (the 1h watcher deadline, the 45min subagent deadline), so nothing live can
 * reach a pruned id. The rows are also the only dataset for auditing
 * classification accuracy, so do not shorten this without a reader in place.
 */
export const WORK_ROW_RETENTION_MS = 24 * 60 * 60_000;

/**
 * How long after a failed delivery the sweep's retry is given another wake.
 *
 * An owed row (`terminal !== null && deliveredAt === null`) is CLOSED, so it is
 * invisible to `listOpen()` and `nextSweepAt` returns nothing for it. Without a
 * horizon of its own, a thread whose last open row closed and then failed to
 * deliver arms no alarm at all, and the retry pass — the only thing that would
 * ever tell the model — never runs again. The row is owed forever, and `prune`
 * requires `delivered_at IS NOT NULL`, so it is never even collected.
 *
 * 60s, and the shape matters more than the number: this is always folded as
 * `now + WORK_DELIVERY_RETRY_MS`, never as a stored deadline, so a delivery that
 * keeps throwing re-arms one minute out each time instead of spinning. It cannot
 * be tight: a retry pays `resolveComputeService` (a GitHub token mint plus
 * several D1 reads) per wake, and the failure it retries — an injection-buffer
 * write, a `deliverSystemReminder` throw — is not the kind that clears in a
 * second. It cannot be long either: this delay is silence about work that is
 * already over. A minute is well inside the model's patience for a completion it
 * is waiting on, and far outside the cost of a hot loop.
 */
export const WORK_DELIVERY_RETRY_MS = 60_000;

export type WorkKind = "process" | "subagent";

/**
 * The placeholder a row carries when nothing was known about the container's
 * generation at registration — the store held `unknown` or `absent`, or the row
 * predates the nonce entirely (`compute_state.generation = NULL`).
 *
 * It is the ABSENCE of evidence, so it can never be evidence of a MISMATCH.
 * `isReset`'s `known` arm must skip it, and the requirement is not academic: a
 * container whose nonce is restored after a wipe (`restoreGenerationAfterWipe`
 * in compute/thread-service.ts) moves the store from `absent` to `known`, and
 * every row registered during the absence carries this placeholder. Comparing
 * it would fault exactly the rows running on the healthy post-wipe filesystem —
 * the ones the `absent` arm's `observedAt` bound deliberately spares.
 */
export const UNKNOWN_GENERATION = "unknown";

/**
 * How a unit of work ended. `stopped` is deliberately distinct from `exited`:
 * with enforcement on, the terminal is what the model is TOLD, and a process
 * someone killed did not exit cleanly — reporting it as `exited` is a lie the
 * model would act on. It reuses the word `ComputeProcessStatus` already uses
 * for a killed process rather than inventing new vocabulary.
 */
export type WorkOutcome = "exited" | "stopped" | "timeout" | "fault";
export type WorkReason =
  | "process_exit"
  | "process_stopped"
  | "watch_timeout"
  | "sandbox_reset"
  | "no_liveness";

/**
 * The reasons the reaper infers from a row alone. NARROWLY scoped, and the
 * scope is the whole point: this set is sound ONLY as the SUBAGENT-row question
 * `reaperAlreadyReported` asks of it.
 *
 * It is NOT "the reasons only the reaper produces", and it is NOT "who owns
 * delivery" — reason is not a proxy for either. `watch_timeout` has TWO writers:
 * the reaper, and `pollWatcher` (compute/thread-service.ts), which closes a
 * backgrounded process that outlived its watch on a perfectly healthy sandbox
 * and delivers its own reminder. Reading this set as a delivery-ownership test
 * made the sweep re-deliver exactly that reminder; ownership is DECLARED by
 * stamping `delivered_at` (see `WorkLedgerStore.markDelivered`), never inferred
 * from here.
 *
 * What it IS: on a SUBAGENT row every one of these reasons is reaper-written —
 * nothing else can produce them for a subagent, since `onAgentToolFinish` only
 * ever writes `process_exit`/`process_stopped`. So for a subagent run, a row
 * bearing one of these means the reaper WROTE this row's terminal — nothing
 * about whether the model was actually TOLD. That is `delivered_at`, not the
 * reason, and this read deliberately does not consult it: gating on
 * `delivered_at` looks like the safe hardening but is UNSAFE — it makes
 * `_deliverDetachedTerminal` inject the real completion while the row stays
 * owed, so the next sweep delivers it a second time. So this is how the
 * detached-terminal override tells the reaper's own kill (a second SDK
 * `finish` fired through `cancelSubagentRun`) apart from a real completion that
 * must still be reported — even though, when the reaper's own delivery threw,
 * "the reaper wrote this terminal" is all it establishes, not "the reaper told
 * the model". In that case the override suppresses the real completion and the
 * model is told the reaper's (now false) message instead — a follow-up task,
 * not this one, moves the stamp into the override to close that gap. Terminals
 * are exactly-once, so the reason on the row is always the FIRST writer's — the
 * reaper's kill cannot overwrite it.
 */
export const REAPER_WORK_REASONS: ReadonlySet<WorkReason> = new Set<WorkReason>([
  "sandbox_reset",
  "no_liveness",
  "watch_timeout",
]);

export interface WorkTerminal {
  outcome: WorkOutcome;
  reason: WorkReason;
  at: number;
  detail: string;
}

export interface WorkRow {
  id: string;
  kind: WorkKind;
  startedAt: number;
  /**
   * Stamped by infrastructure, never by the model. What it proves differs by
   * kind: a `process` row is stamped by the watcher poll observing the process
   * still running, whereas a `subagent` row is stamped by the child's in-flight
   * heartbeat — which proves its event loop is turning, not that work is
   * progressing. A same-generation hang is bounded by `deadlineAt`; a sandbox
   * reset is caught by the generation check, which `classifyWork` evaluates
   * BEFORE liveness.
   */
  lastAliveAt: number;
  staleAfterMs: number;
  deadlineAt: number;
  /**
   * The sandbox generation nonce observed when this row was registered, or
   * `UNKNOWN_GENERATION` when there was none to observe. It is EVIDENCE, not an
   * identifier: only a real nonce may ever witness a mismatch.
   */
  generation: string;
  terminal: WorkTerminal | null;
  /**
   * When this row's notification obligation was DISCHARGED, or null while it is
   * still owed. A SEPARATE gate from the terminal itself: the terminal write
   * must land unconditionally (an open row pins the alarm horizon in the past),
   * but the delivery it implies can fail on its own and must stay retryable.
   *
   * Meaningful for EVERY terminal, whoever wrote it. A writer that delivers
   * stamps on success; a writer that intends no delivery (`execStop`) stamps at
   * terminalize time. So `terminal !== null && deliveredAt === null` means
   * exactly "the model was never told, and someone still owes it" — no reason
   * filter, no guessing at ownership.
   */
  deliveredAt: number | null;
}

export type WorkClassification =
  | { state: "alive" }
  | { state: "fault"; outcome: "fault"; reason: "sandbox_reset" }
  | { state: "expired"; outcome: "timeout"; reason: "watch_timeout" }
  | { state: "stale"; outcome: "fault"; reason: "no_liveness" };

/**
 * What is known about the LIVE sandbox's generation. A plain `string | null`
 * used to stand in for this and it was the production bug (2026-07-16): `null`
 * meant both "the container answered and the nonce is gone" and "we could not
 * ask", so the first — the only evidence a reset ever actually leaves — was
 * discarded as unknown and `sandbox_reset` was unreachable in production.
 *
 *  - `unknown` — never a reset. Rows fall through to deadline/liveness.
 *  - `known`   — compare against the row's nonce; a difference is a reset (the
 *                DO re-provisioned under still-open rows).
 *  - `absent`  — the container answered and its nonce is gone: the filesystem
 *                was wiped. `observedAt` bounds the blast radius to work that
 *                already existed when the wipe was SEEN. Work registered after
 *                that runs on the post-wipe filesystem and is untouched by it —
 *                without this bound a single absent observation would linger in
 *                the store and fault every later row as a reset that never
 *                happened to it.
 *
 * `observedAt` is when the absence was FIRST seen, and the store keeps it that
 * way (`ThreadComputeStore.setGeneration` never re-stamps an absence that is
 * already recorded). The bound is only sound under that reading. Re-stamping it
 * on each probe was a real false-fault seam: Cloudflare hands back a WORKING
 * container after a wipe, so `readOrAcquireRuntime` early-returns on
 * `status === "active"` and never re-provisions — a container could stay
 * nonce-less for its whole life, and every later probe would manufacture a
 * fresh `observedAt` that made healthy post-wipe work look like it predated a
 * brand-new reset. The wipe happened once; it does not keep happening.
 */
export type CurrentGeneration =
  | { kind: "unknown" }
  | { kind: "known"; nonce: string }
  | { kind: "absent"; observedAt: number };

/**
 * Decides what the reaper should do with one row. Precedence is deliberate:
 * a sandbox reset explains both the missed deadline and the silence, so it is
 * reported as the reset it is, not as a timeout.
 *
 * Pure and dependency-free by design: classification reads the row and the
 * supplied generation, never the backend, so a dead sandbox cannot wedge the
 * sweep. The probe that produces `absent` happens on the POLL path, not here.
 */
export function classifyWork(input: {
  row: WorkRow;
  currentGeneration: CurrentGeneration;
  now: number;
}): WorkClassification {
  const { row, currentGeneration, now } = input;
  if (row.terminal) return { state: "alive" };
  if (isReset(row, currentGeneration))
    return { state: "fault", outcome: "fault", reason: "sandbox_reset" };
  if (now > row.deadlineAt)
    return { state: "expired", outcome: "timeout", reason: "watch_timeout" };
  if (now - row.lastAliveAt > row.staleAfterMs)
    return { state: "stale", outcome: "fault", reason: "no_liveness" };
  return { state: "alive" };
}

function isReset(row: WorkRow, currentGeneration: CurrentGeneration): boolean {
  switch (currentGeneration.kind) {
    case "unknown":
      return false;
    case "known":
      // A row with no generation evidence cannot witness a mismatch. Without
      // this the placeholder would read as a nonce that "differs" from every
      // real one, and the rows it guards are precisely those registered while
      // the store knew nothing — including every row on a healthy post-wipe
      // container whose nonce was later restored.
      if (row.generation === UNKNOWN_GENERATION) return false;
      return currentGeneration.nonce !== row.generation;
    case "absent":
      // Strictly BEFORE: work registered at or after the observation may itself
      // be the reason the container was touched, and it never saw the old
      // filesystem. Only work that predates the observation lost anything.
      //
      // Sound only because `observedAt` is the FIRST sighting of the absence
      // and never moves while the absence persists (see `CurrentGeneration`).
      return row.startedAt < currentGeneration.observedAt;
  }
}

/**
 * The earliest time the reaper needs to look again: the soonest horizon across
 * every open row. Returns null when there is no open work. The caller folds
 * this into the DO alarm alongside compute eviction (see `nextWakeAt` in
 * compute/watchers.ts).
 */
export function nextSweepAt(rows: WorkRow[]): number | null {
  let min: number | null = null;
  for (const row of rows) {
    if (row.terminal) continue;
    const horizon = Math.min(row.deadlineAt, row.lastAliveAt + row.staleAfterMs);
    if (min === null || horizon < min) min = horizon;
  }
  return min;
}

/**
 * The model-facing text for a terminal the model has not already been told
 * about. The sandbox_reset wording is load-bearing: it must say the FILESYSTEM
 * is gone, not merely that a process died. In the incident this design came
 * from, that is the difference between the model adapting (its /tmp scratch is
 * empty -> redo the work in smaller batches) and waiting forever for output
 * that no longer exists.
 *
 * Every reason gets a case, including the two the reaper can never produce
 * (`process_exit`, `process_stopped` — the compute layer closes those rows on
 * the spot). They are here so the switch stays exhaustive and so any future
 * caller that funnels one through gets an honest sentence rather than a
 * borrowed one: a stopped process was STOPPED, not exited.
 */
export function buildFaultMessage(input: {
  reason: WorkReason;
  kind: WorkKind;
  id: string;
  label: string;
  silentMs: number;
}): string {
  const subject =
    input.kind === "subagent" ? `Subagent ${input.label}` : `Background process ${input.label}`;
  switch (input.reason) {
    case "sandbox_reset":
      return `${subject} (${input.id}) is gone: the sandbox was reset. Every file it wrote and all of its output are lost, and the filesystem is now empty. Any work that depended on that state must be redone — consider a smaller batch or lower concurrency, since a reset is usually the container running out of memory.`;
    case "no_liveness":
      return `${subject} (${input.id}) showed no liveness signal for ${Math.round(input.silentMs / 1000)}s and has been torn down. Its output may be incomplete.`;
    case "watch_timeout":
      // A subagent needs its own sentence, and this is its DEFAULT path, not an
      // edge case: the row's `deadlineAt` is stamped at register — a beat before
      // the SDK's `maxBudgetMs` clock starts at dispatch — so the ledger always
      // fires first, and this is what the model reads for every subagent that
      // hits its budget. The process wording would be wrong twice over: a
      // subagent was never *watched*, and `terminalizeWork` KILLS it via
      // `cancelSubagentRun` rather than walking away from it. A process, by
      // contrast, really is left running and merely unwatched.
      return input.kind === "subagent"
        ? `${subject} (${input.id}) hit its ${Math.round(SUBAGENT_DEADLINE_MS / 60_000)}-minute time budget and was stopped before it finished. It did not run to completion, so any result it had not already reported is lost. If you still need this work, re-run it as a narrower task.`
        : `${subject} (${input.id}) is still running past the watch timeout; it is no longer being watched.`;
    case "process_stopped":
      return `${subject} (${input.id}) was stopped before it finished. It did not run to completion, so its output is partial.`;
    case "process_exit":
      return `${subject} (${input.id}) exited.`;
  }
}
