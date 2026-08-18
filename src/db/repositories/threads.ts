import { and, desc, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { DrizzleQueryError } from "drizzle-orm/errors";
import type { D1Transaction, DrizzleD1Database } from "drizzle-orm/d1";
import type * as schema from "../schema";
import {
  automata,
  workbenches,
  projects,
  threadIndex,
  threadRepositorySnapshots,
  threadTokenUsage,
  threadWorkbenchSnapshots,
  type ThreadIndex,
} from "../schema";
import { ThreadRepositorySnapshotRepository } from "./thread-repository-snapshots";

/** Maximum length for a thread title, enforced on both auto-naming and manual rename. */
export const MAX_TITLE_LEN = 80;

type ThreadRepositoryDb = DrizzleD1Database<typeof schema> | D1Transaction<typeof schema, any>;

export type ThreadListFilters = {
  status?: "active" | "archived" | "all";
  project?: { kind: "all" } | { kind: "unassigned" } | { kind: "project"; projectId: string };
};

export class ThreadRepository {
  constructor(private readonly db: ThreadRepositoryDb) {}

  async create(input: typeof threadIndex.$inferInsert) {
    await this.db.insert(threadIndex).values(input);
    return input;
  }

  async createWithWorkbench(input: typeof threadIndex.$inferInsert, workbenchId: string | null) {
    const row = { ...input, workbenchId };

    if (workbenchId === null) {
      await this.create(row);
      return row;
    }

    await this.db.transaction(async (tx) => {
      const threads = new ThreadRepository(tx);
      const snapshots = new ThreadRepositorySnapshotRepository(tx);

      await threads.create(row);
      await snapshots.replaceFromWorkbench(row.id, row.workspaceId, workbenchId, row.createdAt);
    });

    return row;
  }

  async listForWorkspace(
    workspaceId: string,
    filters: "active" | "archived" | "all" | ThreadListFilters = "active",
  ): Promise<ThreadIndex[]> {
    const normalizedFilters =
      typeof filters === "string"
        ? { status: filters, project: { kind: "all" as const } }
        : {
            status: filters.status ?? "active",
            project: filters.project ?? { kind: "all" as const },
          };

    const archiveFilter =
      normalizedFilters.status === "active"
        ? isNull(threadIndex.archivedAt)
        : normalizedFilters.status === "archived"
          ? isNotNull(threadIndex.archivedAt)
          : undefined;

    const projectFilter =
      normalizedFilters.project.kind === "all"
        ? undefined
        : normalizedFilters.project.kind === "unassigned"
          ? isNull(threadIndex.projectId)
          : eq(threadIndex.projectId, normalizedFilters.project.projectId);

    const whereClauses = [
      eq(threadIndex.workspaceId, workspaceId),
      ne(threadIndex.kind, "feedback"),
    ];
    if (archiveFilter) {
      whereClauses.push(archiveFilter);
    }
    if (projectFilter) {
      whereClauses.push(projectFilter);
    }

    return this.db
      .select()
      .from(threadIndex)
      .where(and(...whereClauses))
      .orderBy(
        normalizedFilters.status === "archived"
          ? desc(threadIndex.archivedAt)
          : desc(threadIndex.updatedAt),
      )
      .all();
  }

  async getById(threadId: string) {
    return this.db.select().from(threadIndex).where(eq(threadIndex.id, threadId)).get();
  }

  /**
   * Like {@link getById}, but enriched with the project name, automaton name,
   * and repository snapshot count via the same joins the sidebar list query
   * uses. Live-update broadcasts (`thread.created` / `thread.updated`) MUST
   * serialize this shape: a bare threadIndex row has no `projectName` /
   * `automatonName`, so the client's whole-object merge would drop the
   * sidebar badges until the next refetch.
   */
  async getSummaryRowById(threadId: string) {
    const base = await this.getById(threadId);
    if (!base) return null;
    const enrichment = await this.db
      .select({
        projectName: projects.name,
        workbenchName: workbenches.name,
        automatonName: automata.name,
        automatonNotifyMode: automata.notifyMode,
        repositorySnapshotCount: sql<number>`count(${threadRepositorySnapshots.id})`,
        snapshotResourceProfile: threadWorkbenchSnapshots.resourceProfile,
      })
      .from(threadIndex)
      .leftJoin(projects, eq(projects.id, threadIndex.projectId))
      .leftJoin(workbenches, eq(workbenches.id, threadIndex.workbenchId))
      .leftJoin(automata, eq(automata.id, threadIndex.automatonId))
      .leftJoin(threadRepositorySnapshots, eq(threadRepositorySnapshots.threadId, threadIndex.id))
      // 1:1 on threadId (the snapshot table's primary key), so this cannot
      // multiply rows the way the thread_repository_snapshots join would.
      .leftJoin(threadWorkbenchSnapshots, eq(threadWorkbenchSnapshots.threadId, threadIndex.id))
      .where(eq(threadIndex.id, threadId))
      .groupBy(
        threadIndex.id,
        projects.name,
        workbenches.name,
        automata.name,
        threadWorkbenchSnapshots.resourceProfile,
      )
      .get();
    return {
      ...base,
      projectName: enrichment?.projectName ?? null,
      workbenchName: enrichment?.workbenchName ?? null,
      automatonName: enrichment?.automatonName ?? null,
      automatonNotifyMode: enrichment?.automatonNotifyMode ?? null,
      repositorySnapshotCount: enrichment?.repositorySnapshotCount ?? 0,
      snapshotResourceProfile: enrichment?.snapshotResourceProfile ?? null,
    };
  }

  async update(
    threadId: string,
    fields: {
      title?: string;
      titleSet?: boolean;
      updatedAt?: number;
      archivedAt?: number | null;
      reasoningEffort?: string;
    },
  ) {
    await this.db.update(threadIndex).set(fields).where(eq(threadIndex.id, threadId));
  }

  /**
   * Commit a mid-thread model switch. All six columns move together — a
   * partial write produces a thread that claims reasoning support it does
   * not have.
   *
   * Deliberately does NOT touch `updatedAt`: thread dismissal is
   * `recentDismissedAt >= updatedAt`, so bumping it here would silently
   * un-dismiss the thread. The user message sent in the same turn already
   * owns that column.
   */
  async updateModelSnapshot(
    threadId: string,
    value: {
      provider: string;
      model: string;
      modelInputModalities: string[];
      showReasoning: boolean;
      reasoningEffort: string;
      modelSupportsReasoning: boolean | null;
    },
  ) {
    await this.db
      .update(threadIndex)
      .set({
        modelProvider: value.provider,
        model: value.model,
        modelInputModalities: JSON.stringify(value.modelInputModalities),
        showReasoning: value.showReasoning,
        reasoningEffort: value.reasoningEffort,
        modelSupportsReasoning: value.modelSupportsReasoning,
      })
      .where(eq(threadIndex.id, threadId));
  }

  async archive(threadId: string, archivedAt: number) {
    await this.db
      .update(threadIndex)
      .set({ archivedAt })
      .where(and(eq(threadIndex.id, threadId), isNull(threadIndex.archivedAt)));
  }

  /**
   * Record a refused auto-archive against the activity stamp it saw, so the
   * oldest-first cron batch stops re-picking the same unarchivable thread every
   * run. `updatedAt` itself is deliberately left alone: it is the user-visible
   * activity clock and the idle cutoff both read from it, so bumping it would
   * lie about activity and reset the idle timer.
   */
  async markArchiveSkipped(threadId: string, observedUpdatedAt: number) {
    await this.db
      .update(threadIndex)
      .set({ archiveSkippedUpdatedAt: observedUpdatedAt })
      .where(eq(threadIndex.id, threadId));
  }

  async invalidateSearchCheckpoint(threadId: string): Promise<void> {
    await this.db
      .update(threadIndex)
      .set({ searchIndexedThrough: null })
      .where(eq(threadIndex.id, threadId));
  }

  /**
   * Advances the search projection checkpoint without changing `updatedAt`.
   * The projection observes `updatedAt`, so bumping it here would make indexing
   * create the next stale revision itself.
   */
  async updateSearchProjectionMeta(
    threadId: string,
    fields: { observedUpdatedAt: number; lastMessagePreview: string },
  ): Promise<void> {
    await this.db
      .update(threadIndex)
      .set({
        searchIndexedThrough: sql`
          CASE
            WHEN ${threadIndex.searchIndexedThrough} IS NULL
              OR ${threadIndex.searchIndexedThrough} < ${fields.observedUpdatedAt}
              THEN ${fields.observedUpdatedAt}
            ELSE ${threadIndex.searchIndexedThrough}
          END
        `,
        lastMessagePreview: sql`
          CASE
            WHEN ${threadIndex.updatedAt} = ${fields.observedUpdatedAt}
              THEN ${fields.lastMessagePreview}
            ELSE ${threadIndex.lastMessagePreview}
          END
        `,
        searchRepairAttempts: null,
      })
      .where(eq(threadIndex.id, threadId));
  }

  async delete(threadId: string) {
    const snapshots = new ThreadRepositorySnapshotRepository(this.db);
    await snapshots.clearForThread(threadId);
    await snapshots.clearWorkbenchSnapshot(threadId);
    await this.db.delete(threadTokenUsage).where(eq(threadTokenUsage.threadId, threadId));
    await this.db.delete(threadIndex).where(eq(threadIndex.id, threadId));
  }

  async listForAutomaton(input: { workspaceId: string; automatonId: string }) {
    return this.db
      .select()
      .from(threadIndex)
      .where(
        and(
          eq(threadIndex.workspaceId, input.workspaceId),
          eq(threadIndex.automatonId, input.automatonId),
          ne(threadIndex.kind, "feedback"),
          isNull(threadIndex.archivedAt),
        ),
      )
      .orderBy(desc(threadIndex.createdAt))
      .all();
  }

  /**
   * Retargets a thread's project. Repository access no longer flows through
   * projects — that snapshot is keyed on the thread's `workbenchId` (see
   * {@link updateWorkbench}) — so this is a plain column update.
   */
  async updateProject(
    threadId: string,
    projectId: string | null,
    updatedAt: number,
  ): Promise<void> {
    const thread = await this.db
      .select()
      .from(threadIndex)
      .where(eq(threadIndex.id, threadId))
      .get();

    if (!thread) {
      throw new Error("thread_not_found");
    }

    await this.db
      .update(threadIndex)
      .set({ projectId, updatedAt })
      .where(eq(threadIndex.id, threadId));
  }

  async updateWorkbench(
    threadId: string,
    workbenchId: string | null,
    updatedAt: number,
  ): Promise<void> {
    await this.withTransactionalWrite(
      async (tx) => {
        const snapshots = new ThreadRepositorySnapshotRepository(tx);
        const thread = await tx
          .select()
          .from(threadIndex)
          .where(eq(threadIndex.id, threadId))
          .get();

        if (!thread) {
          throw new Error("thread_not_found");
        }

        // Clearing the pending marker is part of the immediate switch, not
        // housekeeping: this path moves the snapshot NOW, so any switch window
        // opened earlier is resolved. A marker left armed would both disable
        // the picker forever and arm the turn-end backstop to `execShutdown` a
        // sandbox the user is actively working in.
        await tx
          .update(threadIndex)
          .set({ workbenchId, workbenchSwitchPendingAt: null, updatedAt })
          .where(eq(threadIndex.id, threadId));

        await snapshots.replaceFromWorkbench(threadId, thread.workspaceId, workbenchId, updatedAt);
      },
      (db) => this.updateWorkbenchWithoutTransaction(db, threadId, workbenchId, updatedAt),
    );
  }

  /**
   * Opens a switch window: the column becomes the intent, the snapshot stays
   * the reality until {@link commitWorkbenchSwitch}. Used when a sandbox is
   * live and the agent must be given a chance to save its work first.
   */
  async beginWorkbenchSwitch(
    threadId: string,
    workbenchId: string | null,
    at: number,
  ): Promise<void> {
    await this.db
      .update(threadIndex)
      .set({ workbenchId, workbenchSwitchPendingAt: at, updatedAt: at })
      .where(eq(threadIndex.id, threadId));
  }

  /**
   * Undoes a {@link beginWorkbenchSwitch} that never got its reminder
   * delivered (the agent RPC threw after the marker landed). Restores the
   * pre-switch `workbenchId` and clears the pending marker with a plain
   * column update — symmetric with `beginWorkbenchSwitch`, which also never
   * touches the snapshot. There is nothing to reconcile on the snapshot
   * side: `beginWorkbenchSwitch` never moved it, so it is still sitting on
   * the workbench this call restores `workbenchId` to.
   */
  async abandonWorkbenchSwitch(
    threadId: string,
    previousWorkbenchId: string | null,
    at: number,
  ): Promise<void> {
    await this.db
      .update(threadIndex)
      .set({ workbenchId: previousWorkbenchId, workbenchSwitchPendingAt: null, updatedAt: at })
      .where(eq(threadIndex.id, threadId));
  }

  /**
   * Closes the window. The conditional update is the commit permit: the
   * tool-call path and the turn-end backstop both call this, and normally only
   * the one that actually clears the marker proceeds to tear down.
   *
   * Ordering matters: the re-snapshot happens BEFORE the marker is cleared,
   * not after. Every caller reads the same `thread.workbenchId`, so the
   * re-snapshot is idempotent — concurrent or retried callers write identical
   * rows. If it throws, the marker is still set, so the turn-end backstop can
   * retry on a later turn. Clearing the marker first (the old ordering) made
   * a snapshot failure unrecoverable: the permit would already be gone, no
   * caller could retry, and the thread would be left with `threadIndex`
   * pointing at the new workbench while `thread_workbench_snapshots` still
   * held the old one — the same cross-workbench mismatch
   * {@link updateWorkbenchWithoutTransaction} guards against, just reached
   * from the other direction. The guard at the top (no pending switch → do
   * nothing) matters for the same reason: the turn-end backstop calls this on
   * every turn, and without it a thread with no pending switch would get
   * needlessly re-snapshotted every time.
   *
   * `meta.changes` is NOT trustworthy on D1 — local D1 has returned `null` for
   * a statement where remote returned an integer (see the comment at
   * src/compute/container-ledger.ts:71). Treating an unreadable count as "I
   * lost" would let BOTH callers stand down, leaving the thread wedged in
   * "switching" forever. So an unreadable count falls through to a read-back
   * and proceeds if the marker is gone.
   *
   * That makes the guarantee at-least-once, not exactly-once. This is the safe
   * direction, because commit is idempotent: re-snapshotting the same workbench
   * writes the same rows, and `execShutdown` already tolerates an
   * already-destroyed runtime. A double commit is a no-op; a zero commit is a
   * permanent wedge.
   */
  async commitWorkbenchSwitch(threadId: string, at: number): Promise<boolean> {
    const thread = await this.db
      .select()
      .from(threadIndex)
      .where(eq(threadIndex.id, threadId))
      .get();
    if (!thread) throw new Error("thread_not_found");
    if (thread.workbenchSwitchPendingAt === null) return false;

    const snapshots = new ThreadRepositorySnapshotRepository(this.db);
    await snapshots.replaceFromWorkbench(threadId, thread.workspaceId, thread.workbenchId, at);

    const result = await this.db
      .update(threadIndex)
      .set({ workbenchSwitchPendingAt: null, updatedAt: at })
      .where(and(eq(threadIndex.id, threadId), isNotNull(threadIndex.workbenchSwitchPendingAt)));

    const changes = result.meta?.changes;
    if (typeof changes === "number") {
      if (changes !== 1) return false;
    } else {
      // Unreadable count: confirm by reading the row back. Proceeds on a
      // cleared marker even if another caller cleared it — see the note above.
      const row = await this.db
        .select({ pendingAt: threadIndex.workbenchSwitchPendingAt })
        .from(threadIndex)
        .where(eq(threadIndex.id, threadId))
        .get();
      if (!row || row.pendingAt !== null) return false;
    }

    return true;
  }

  /**
   * D1-transaction-unsupported fallback. Writes the snapshot side (assert +
   * build + clear + insert) before the `threadIndex.workbenchId` column. If
   * that snapshot write never commits (validation error, or the write itself
   * fails), the thread's current workbench assignment is left untouched.
   * But if the snapshot write DOES commit and the trailing column update then
   * fails, the thread would otherwise be left pointing `workbenchId` at the
   * OLD workbench while its snapshots reflect the NEW one — a
   * cross-workbench mismatch. To avoid that, a column-update failure after
   * a successful snapshot write is followed by a best-effort reconcile back
   * to a consistent unassigned state (`workbenchId: null` + cleared
   * snapshots) before the original error is rethrown.
   */
  private async updateWorkbenchWithoutTransaction(
    db: ThreadRepositoryDb,
    threadId: string,
    workbenchId: string | null,
    updatedAt: number,
  ): Promise<void> {
    const snapshots = new ThreadRepositorySnapshotRepository(db);
    const thread = await db.select().from(threadIndex).where(eq(threadIndex.id, threadId)).get();

    if (!thread) {
      throw new Error("thread_not_found");
    }

    let snapshotsCommitted = false;
    try {
      await snapshots.replaceFromWorkbench(threadId, thread.workspaceId, workbenchId, updatedAt);
      snapshotsCommitted = true;

      await db
        .update(threadIndex)
        .set({ workbenchId, workbenchSwitchPendingAt: null, updatedAt })
        .where(eq(threadIndex.id, threadId));
    } catch (error) {
      if (snapshotsCommitted) {
        await snapshots
          .replaceFromWorkbench(threadId, thread.workspaceId, null, updatedAt)
          .catch(() => {});
        await db
          .update(threadIndex)
          .set({ workbenchId: null, workbenchSwitchPendingAt: null, updatedAt })
          .where(eq(threadIndex.id, threadId))
          .catch(() => {});
      }
      throw error;
    }
  }

  private async withTransactionalWrite<T>(
    transactionalWrite: (tx: ThreadRepositoryDb) => Promise<T>,
    fallbackWrite: (db: ThreadRepositoryDb) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.db.transaction(async (tx) => transactionalWrite(tx));
    } catch (error) {
      if (this.isUnsupportedD1TransactionStartError(error)) {
        return fallbackWrite(this.db);
      }
      throw error;
    }
  }

  private isUnsupportedD1TransactionStartError(error: unknown): boolean {
    if (!(error instanceof DrizzleQueryError)) {
      return false;
    }
    if (error.query !== "begin" || error.params.length !== 0) {
      return false;
    }

    const cause = error.cause;
    return (
      cause instanceof Error &&
      cause.message.includes("please use the state.storage.transaction()") &&
      cause.message.includes("SQL BEGIN TRANSACTION")
    );
  }
}
