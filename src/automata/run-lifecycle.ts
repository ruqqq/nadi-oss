import { and, eq, inArray } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type * as schema from "../db/schema";
import { automatonRuns } from "../db/schema";
import type { AutomatonRunStatus } from "../db/schema";

export const TERMINAL_RUN_STATUSES = [
  "completed",
  "waiting_for_approval",
  "failed",
  "skipped",
] as const satisfies readonly AutomatonRunStatus[];

export type AutomatonLifecycleEvent =
  | { type: "thread.started"; startedAt: number }
  | { type: "thread.completed"; occurredAt: number }
  | { type: "thread.attention_required"; occurredAt: number; reason?: string }
  | { type: "thread.failed"; occurredAt: number; reason?: string };

type RunPatch = Partial<typeof automatonRuns.$inferInsert>;

/**
 * The status a run must currently hold for this event to apply. Thread lifecycle
 * hooks fire on EVERY turn, but a run ends at the FIRST turn end — so closure is
 * one-way and idempotent. Replying in an automaton thread tomorrow must not
 * reopen last night's run, and a duplicate lifecycle event must be a no-op.
 */
export function transitionFor(event: AutomatonLifecycleEvent): {
  from: AutomatonRunStatus[];
  patch: RunPatch;
} {
  switch (event.type) {
    case "thread.started":
      // Only from `queued`: a second turn while still `running` must not
      // restart the clock.
      return { from: ["queued"], patch: { status: "running", startedAt: event.startedAt } };
    case "thread.completed":
      return {
        from: ["queued", "running"],
        patch: { status: "completed", finishedAt: event.occurredAt },
      };
    case "thread.attention_required":
      return {
        from: ["queued", "running"],
        patch: { status: "waiting_for_approval", ...(event.reason ? { error: event.reason } : {}) },
      };
    case "thread.failed":
      return {
        from: ["queued", "running"],
        patch: {
          status: "failed",
          finishedAt: event.occurredAt,
          ...(event.reason ? { error: event.reason } : {}),
        },
      };
  }
}

export async function applyAutomatonRunLifecycleEvent(input: {
  db: DrizzleD1Database<typeof schema>;
  runId: string;
  event: AutomatonLifecycleEvent;
}): Promise<void> {
  const { from, patch } = transitionFor(input.event);
  await input.db
    .update(automatonRuns)
    .set({ ...patch, updatedAt: Date.now() })
    .where(and(eq(automatonRuns.id, input.runId), inArray(automatonRuns.status, from)));
}
