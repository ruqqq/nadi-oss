import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type * as schema from "../schema";
import { automatonRuns, automata } from "../schema";
import type { AutomatonRun, AutomatonRunStatus } from "../schema";

/** Runs in these states still hold the automaton's overlap lock. */
export const UNFINISHED_RUN_STATUSES = ["queued", "running"] as const;

export class AutomatonRepository {
  constructor(private readonly db: DrizzleD1Database<typeof schema>) {}

  async listDue(now: number, limit: number) {
    return this.db
      .select()
      .from(automata)
      .where(
        and(
          eq(automata.enabled, true),
          isNull(automata.archivedAt),
          lt(automata.nextDueAt, now + 1),
        ),
      )
      .orderBy(asc(automata.nextDueAt), asc(automata.id))
      .limit(limit)
      .all();
  }

  async getById(id: string) {
    return this.db.select().from(automata).where(eq(automata.id, id)).get();
  }

  /**
   * Throws on unique-constraint conflict when a scheduled run for this
   * `dueAt` already exists. Callers treat that as "another cron tick already
   * claimed this due" and stop.
   */
  async createRun(input: typeof automatonRuns.$inferInsert) {
    await this.db.insert(automatonRuns).values(input);
    return input;
  }

  async findUnfinishedRun(automatonId: string) {
    return this.db
      .select()
      .from(automatonRuns)
      .where(
        and(
          eq(automatonRuns.automatonId, automatonId),
          inArray(automatonRuns.status, [...UNFINISHED_RUN_STATUSES]),
        ),
      )
      .get();
  }

  async listRuns(automatonId: string, limit = 20) {
    return this.db
      .select()
      .from(automatonRuns)
      .where(eq(automatonRuns.automatonId, automatonId))
      .orderBy(sql`${automatonRuns.createdAt} desc`)
      .limit(limit)
      .all();
  }

  /**
   * The most recent run per automaton, in a single query — used by the list
   * endpoint so it doesn't fan out one `getById`-style fetch per row. Callers
   * must guard the empty-list case themselves: `IN ()` is a SQL error.
   */
  async listLatestRunsFor(automatonIds: string[]): Promise<AutomatonRun[]> {
    if (automatonIds.length === 0) return [];

    const latest = this.db
      .select({
        automatonId: automatonRuns.automatonId,
        maxCreatedAt: sql<number>`max(${automatonRuns.createdAt})`.as("max_created_at"),
      })
      .from(automatonRuns)
      .where(inArray(automatonRuns.automatonId, automatonIds))
      .groupBy(automatonRuns.automatonId)
      .as("latest");

    const rows = await this.db
      .select({
        id: automatonRuns.id,
        automatonId: automatonRuns.automatonId,
        workspaceId: automatonRuns.workspaceId,
        dueAt: automatonRuns.dueAt,
        trigger: automatonRuns.trigger,
        threadId: automatonRuns.threadId,
        status: automatonRuns.status,
        error: automatonRuns.error,
        startedAt: automatonRuns.startedAt,
        finishedAt: automatonRuns.finishedAt,
        createdAt: automatonRuns.createdAt,
        updatedAt: automatonRuns.updatedAt,
      })
      .from(automatonRuns)
      .innerJoin(
        latest,
        and(
          eq(automatonRuns.automatonId, latest.automatonId),
          eq(automatonRuns.createdAt, latest.maxCreatedAt),
        ),
      )
      // A tie on createdAt can return two rows for one automaton; ordering by
      // id and keeping the first seen below makes the pick deterministic
      // rather than arbitrary.
      .orderBy(asc(automatonRuns.id))
      .all();

    const byAutomaton = new Map<string, AutomatonRun>();
    for (const row of rows) {
      if (!byAutomaton.has(row.automatonId)) byAutomaton.set(row.automatonId, row);
    }
    return [...byAutomaton.values()];
  }

  /**
   * A DO that dies mid-turn never emits a lifecycle event, leaving a `running`
   * row that would block this automaton's overlap check forever. Fail those.
   */
  async reapStaleRuns(input: { runningBefore: number; queuedBefore: number; now: number }) {
    const failRun = (status: AutomatonRunStatus, before: number, error: string) =>
      this.db
        .update(automatonRuns)
        .set({ status: "failed", error, finishedAt: input.now, updatedAt: input.now })
        .where(and(eq(automatonRuns.status, status), lt(automatonRuns.updatedAt, before)));

    await failRun("running", input.runningBefore, "no completion signal from the thread");
    await failRun("queued", input.queuedBefore, "run never started");
  }

  /**
   * Persist a post-claim failure onto the run row so the real cause survives
   * (rather than only a `log.warn`, and rather than the misleading "run never
   * started" a later reap would otherwise stamp). Guarded to unfinished
   * statuses so it can never overwrite a terminal status.
   */
  async failRun(runId: string, error: string, now: number): Promise<void> {
    await this.db
      .update(automatonRuns)
      .set({ status: "failed", error, finishedAt: now, updatedAt: now })
      .where(
        and(
          eq(automatonRuns.id, runId),
          inArray(automatonRuns.status, [...UNFINISHED_RUN_STATUSES]),
        ),
      );
  }

  async setRunThread(runId: string, threadId: string, now: number) {
    await this.db
      .update(automatonRuns)
      .set({ threadId, updatedAt: now })
      .where(eq(automatonRuns.id, runId));
  }

  async advanceSchedule(automatonId: string, nextDueAt: number, lastFiredAt: number | null) {
    const now = Date.now();
    await this.db
      .update(automata)
      .set({ nextDueAt, ...(lastFiredAt === null ? {} : { lastFiredAt }), updatedAt: now })
      .where(eq(automata.id, automatonId));
  }

  async disableWithReason(automatonId: string, reason: string, now: number) {
    await this.db
      .update(automata)
      .set({ enabled: false, disabledReason: reason, updatedAt: now })
      .where(eq(automata.id, automatonId));
  }

  /** After a one-shot schedule fires or its due is consumed by a skip. */
  async disableAfterOnceFire(automatonId: string, lastFiredAt: number | null) {
    const now = Date.now();
    await this.db
      .update(automata)
      .set({
        enabled: false,
        nextDueAt: null,
        disabledReason: null,
        ...(lastFiredAt === null ? {} : { lastFiredAt }),
        updatedAt: now,
      })
      .where(eq(automata.id, automatonId));
  }
}
