/**
 * The scheduler's pure decision layer: constants, the due-action rule, the
 * claim-conflict classifier, and the post-claim error type.
 *
 * Kept free of Workers imports (`agents`, `cloudflare:*`, D1) so it can be unit
 * tested under the node-based `unit` vitest project. `fire-due.ts` holds the
 * I/O — reaching D1 and the Durable Object — and re-exports everything here.
 */

export const AUTO_ARCHIVE_CRON = "0 3 * * *";
export const AUTOMATA_CRON = "* * * * *";

/** Bounds subrequests per tick; the remainder fires on the next minute. */
export const AUTOMATON_FIRE_BATCH = 50;
/** A due older than this is water under the bridge — skip it, don't backfill. */
export const AUTOMATON_GRACE_MS = 3_600_000;
/** A coding automaton can legitimately run long; beyond this it is stuck. */
export const AUTOMATON_RUNNING_TIMEOUT_MS = 7_200_000;
/** A claimed run whose DO never started. */
export const AUTOMATON_QUEUED_TIMEOUT_MS = 300_000;

export function decideDueAction(input: {
  dueAt: number;
  now: number;
  hasUnfinishedRun: boolean;
}): "fire" | "skip_overlap" | "skip_stale" {
  // Overlap is checked first: a stuck run must surface as an overlap skip, not
  // be masked by the due it is blocking having gone stale.
  if (input.hasUnfinishedRun) return "skip_overlap";
  if (input.now - input.dueAt > AUTOMATON_GRACE_MS) return "skip_stale";
  return "fire";
}

/**
 * Walks `error` and its `cause` chain (defensively — never throws, tolerates
 * circular causes) looking for the D1/SQLite unique-constraint message. Used
 * to distinguish "another tick already claimed this due" from a real failure,
 * both of which surface as a thrown error from the claim insert.
 */
export function isUniqueConstraintError(error: unknown): boolean {
  try {
    const seen = new Set<unknown>();
    let current: unknown = error;
    for (let depth = 0; depth < 10; depth++) {
      if (current === null || current === undefined) return false;
      if (typeof current === "object") {
        if (seen.has(current)) return false;
        seen.add(current);
      }
      const text = current instanceof Error ? current.message : String(current);
      if (text.includes("UNIQUE constraint failed")) return true;
      if (typeof current !== "object") return false;
      const cause = (current as { cause?: unknown }).cause;
      if (cause === undefined) return false;
      current = cause;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Thrown by `startAutomatonRun` when the claim itself succeeded but a later
 * stage (agent lookup, thread creation, DO dispatch) failed. Distinct from a
 * claim conflict: the run row already exists and has been marked `failed` with
 * the real cause, so the caller MUST still advance the schedule — the claim is
 * consumed either way.
 */
export class AutomatonRunFailedAfterClaim extends Error {
  constructor(cause: unknown) {
    super(String(cause), { cause });
    this.name = "AutomatonRunFailedAfterClaim";
  }
}
