import { and, desc, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { D1Transaction, DrizzleD1Database } from "drizzle-orm/d1";
import type * as schema from "../schema";
import {
  agentRepositories,
  automata,
  workbenches,
  projects,
  threadIndex,
  threadTokenUsage,
  type ThreadIndex,
} from "../schema";

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

  /** Environment assignment is a plain column on the row — there is no
   *  per-thread configuration snapshot to write alongside it any more. */
  async createWithWorkbench(input: typeof threadIndex.$inferInsert, workbenchId: string | null) {
    const row = { ...input, workbenchId };
    await this.create(row);
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
        repositoryCount: sql<number>`count(${agentRepositories.id})`,
        workbenchResourceProfile: workbenches.resourceProfile,
      })
      .from(threadIndex)
      .leftJoin(projects, eq(projects.id, threadIndex.projectId))
      .leftJoin(workbenches, eq(workbenches.id, threadIndex.workbenchId))
      .leftJoin(automata, eq(automata.id, threadIndex.automatonId))
      // Counts the environment's LIVE repositories; this is the join that can
      // multiply rows, which is why the aggregate + groupBy stay.
      .leftJoin(agentRepositories, eq(agentRepositories.agentId, threadIndex.workbenchId))
      .where(eq(threadIndex.id, threadId))
      .groupBy(
        threadIndex.id,
        projects.name,
        workbenches.name,
        workbenches.resourceProfile,
        automata.name,
      )
      .get();
    return {
      ...base,
      projectName: enrichment?.projectName ?? null,
      workbenchName: enrichment?.workbenchName ?? null,
      automatonName: enrichment?.automatonName ?? null,
      automatonNotifyMode: enrichment?.automatonNotifyMode ?? null,
      repositorySnapshotCount: enrichment?.repositoryCount ?? 0,
      snapshotResourceProfile: enrichment?.workbenchResourceProfile ?? null,
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
   * projects — it is keyed on the thread's `workbenchId` (see
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

  /**
   * Retargets a thread's environment. A plain column update: configuration is
   * LIVE, so the next turn's sandbox preparation simply reads the new
   * environment. There is no snapshot to move, and therefore no switch
   * handshake, no pending marker and no sandbox teardown here.
   */
  async updateWorkbench(
    threadId: string,
    workbenchId: string | null,
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
      .set({ workbenchId, updatedAt })
      .where(eq(threadIndex.id, threadId));
  }
}
