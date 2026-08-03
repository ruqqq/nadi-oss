/**
 * `thread_index.runtime` records which chat Durable Object a thread was created
 * against. Only `"think"` is live: `"legacy"` was `ThreadAgentV2`, whose class
 * has been deleted from the Worker.
 *
 * The value is kept — not collapsed — because rows still carry it and narrowing
 * the column would force a table rebuild. It no longer selects a route; it now
 * only marks a thread as belonging to a runtime that cannot be reached, which
 * every caller treats as read-only. That is deliberately fail-closed: a `legacy`
 * row must refuse rather than dial a namespace that no longer exists.
 */
export const THREAD_RUNTIMES = ["legacy", "think"] as const;

export type ThreadRuntime = (typeof THREAD_RUNTIMES)[number];

/** Anything not recognizably `think` belongs to the retired runtime. */
export function normalizeThreadRuntime(value: unknown): ThreadRuntime {
  return value === "think" ? "think" : "legacy";
}

/**
 * Whether this thread's transcript is live in a Durable Object, as opposed to
 * frozen in the D1 archive. Two ways to fail: it was archived (DO destroyed at
 * archive time), or it is on the retired runtime (class deleted).
 *
 * Deliberately NOT in the active-transcript adapter next to `activeTranscriptRpc`.
 * Tests mock that module to stub the DO transport, and a whole-module mock would
 * blank this predicate out with it — turning the gate off in exactly the tests
 * that exercise the paths it guards.
 */
export function hasLiveTranscript(thread: { runtime: string; archivedAt: number | null }): boolean {
  return thread.archivedAt === null && normalizeThreadRuntime(thread.runtime) === "think";
}
