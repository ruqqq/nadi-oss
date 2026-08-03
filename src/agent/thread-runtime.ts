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
