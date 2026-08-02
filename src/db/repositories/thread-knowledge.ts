import { and, desc, eq, gte, isNotNull, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "../schema";
import { projects, threadIndex } from "../schema";
import type {
  DateInterval,
  SearchThreadExcerpt,
  SearchThreadMatchField,
  ThreadStatusFilter,
  ThreadSummary,
} from "../../thread-knowledge/types";
import {
  THREAD_SEARCH_EXCERPT_MAX_CHARS,
  THREAD_SEARCH_MAX_EXCERPTS,
} from "../../thread-knowledge/types";

type ThreadKnowledgeDb = DrizzleD1Database<typeof schema>;

export type ListThreadsQuery = {
  workspaceId: string;
  status: ThreadStatusFilter;
  projectId?: string;
  includeAutomata: boolean;
  interval: DateInterval;
  limit: number;
  cursor?: { updatedAt: number; id: string };
};

export type SearchThreadsMetadataQuery = {
  workspaceId: string;
  query: string;
  matchQuery: string;
  status: ThreadStatusFilter;
  projectId?: string;
  includeAutomata: boolean;
  interval: DateInterval;
  fetchLimit: number;
};

export type LoadEligibleQuery = {
  workspaceId: string;
  threadId: string;
  includeAutomata: boolean;
};

export type EligibleThread = ThreadSummary & {
  runtime: "legacy" | "think";
};

export type ThreadKnowledgeSearchRow = {
  thread: ThreadSummary;
  matchedIn: SearchThreadMatchField[];
  excerpts: SearchThreadExcerpt[];
  indexedThrough: number | null;
  indexState: "current" | "stale";
  ftsRank: number | null;
};

export type PendingThreadCount = {
  pendingThreadCount: number;
  oldestPendingUpdatedAt?: number;
};

type NativeThreadRow = {
  id: string;
  title: string;
  project_id: string | null;
  project_name: string | null;
  source: "manual" | "automaton";
  archived_at: number | null;
  created_at: number;
  updated_at: number;
  last_message_preview: string;
  search_indexed_through: number | null;
  fts_rank?: number | null;
  message_id?: string | null;
  role?: "user" | "assistant" | null;
  message_created_at?: number | null;
  excerpt?: string | null;
  title_match?: number | boolean | null;
  project_match?: number | boolean | null;
  preview_match?: number | boolean | null;
};

const SEARCH_FIELD_ORDER: SearchThreadMatchField[] = ["title", "project", "preview", "message"];

export class ThreadKnowledgeRepository {
  constructor(
    private readonly db: ThreadKnowledgeDb,
    private readonly binding: D1Database,
  ) {}

  async list(input: ListThreadsQuery): Promise<ThreadSummary[]> {
    return (
      await this.db
        .select({
          id: threadIndex.id,
          title: threadIndex.title,
          projectId: threadIndex.projectId,
          projectName: projects.name,
          source: threadIndex.source,
          archivedAt: threadIndex.archivedAt,
          createdAt: threadIndex.createdAt,
          updatedAt: threadIndex.updatedAt,
          lastMessagePreview: threadIndex.lastMessagePreview,
        })
        .from(threadIndex)
        .leftJoin(projects, eq(projects.id, threadIndex.projectId))
        .where(and(...this.drizzleVisibilityClauses(input), ...this.drizzleListCursor(input)))
        .orderBy(desc(threadIndex.updatedAt), desc(threadIndex.id))
        .limit(input.limit + 1)
        .all()
    ).map((row) => ({
      id: row.id,
      title: row.title,
      projectId: row.projectId,
      projectName: row.projectName,
      source: row.source,
      status: row.archivedAt === null ? "active" : "archived",
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      archivedAt: row.archivedAt,
      lastMessagePreview: row.lastMessagePreview,
    }));
  }

  async loadEligible(input: LoadEligibleQuery): Promise<EligibleThread | null> {
    const row = await this.db
      .select({
        id: threadIndex.id,
        title: threadIndex.title,
        projectId: threadIndex.projectId,
        projectName: projects.name,
        source: threadIndex.source,
        runtime: threadIndex.runtime,
        archivedAt: threadIndex.archivedAt,
        createdAt: threadIndex.createdAt,
        updatedAt: threadIndex.updatedAt,
        lastMessagePreview: threadIndex.lastMessagePreview,
      })
      .from(threadIndex)
      .leftJoin(projects, eq(projects.id, threadIndex.projectId))
      .where(
        and(
          eq(threadIndex.id, input.threadId),
          eq(threadIndex.workspaceId, input.workspaceId),
          ne(threadIndex.kind, "feedback"),
          input.includeAutomata ? undefined : eq(threadIndex.source, "manual"),
        ),
      )
      .get();

    if (row === undefined) return null;
    return {
      id: row.id,
      title: row.title,
      projectId: row.projectId,
      projectName: row.projectName,
      source: row.source,
      runtime: row.runtime,
      status: row.archivedAt === null ? "active" : "archived",
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      archivedAt: row.archivedAt,
      lastMessagePreview: row.lastMessagePreview,
    };
  }

  async countPending(
    input: Omit<ListThreadsQuery, "limit" | "cursor">,
  ): Promise<PendingThreadCount> {
    const row = await this.db
      .select({
        count: sql<number>`count(*)`,
        oldest: sql<number | null>`min(${threadIndex.updatedAt})`,
      })
      .from(threadIndex)
      .where(
        and(
          ...this.drizzleVisibilityClauses(input),
          or(
            isNull(threadIndex.searchIndexedThrough),
            lt(threadIndex.searchIndexedThrough, threadIndex.updatedAt),
          ),
        ),
      )
      .get();

    const pendingThreadCount = Number(row?.count ?? 0);
    const oldest = row?.oldest ?? null;
    return {
      pendingThreadCount,
      ...(oldest === null || pendingThreadCount === 0 ? {} : { oldestPendingUpdatedAt: oldest }),
    };
  }

  async searchMetadata(input: SearchThreadsMetadataQuery): Promise<ThreadKnowledgeSearchRow[]> {
    const merged = new Map<string, ThreadKnowledgeSearchRow>();
    const metadataRows = await this.metadataRows(input);
    for (const row of metadataRows) {
      this.mergeSearchRow(merged, row, [
        ...(truthy(row.title_match) ? (["title"] as const) : []),
        ...(truthy(row.project_match) ? (["project"] as const) : []),
        ...(truthy(row.preview_match) ? (["preview"] as const) : []),
      ]);
    }

    const ftsRows = await this.ftsRows(input);
    const ftsMetadataMatches = await this.metadataMatchesByThreadId(
      input,
      ftsRows.map((row) => row.id),
    );
    for (const row of ftsRows) {
      this.mergeSearchRow(merged, row, [...(ftsMetadataMatches.get(row.id) ?? []), "message"]);
    }

    return Array.from(merged.values())
      .map((row) => ({
        ...row,
        matchedIn: SEARCH_FIELD_ORDER.filter((field) => row.matchedIn.includes(field)),
      }))
      .sort(searchResultCompare)
      .slice(0, input.fetchLimit);
  }

  private mergeSearchRow(
    merged: Map<string, ThreadKnowledgeSearchRow>,
    row: NativeThreadRow,
    matchedIn: SearchThreadMatchField[],
  ): void {
    const existing =
      merged.get(row.id) ??
      ({
        thread: summaryFromNativeRow(row),
        matchedIn: [],
        excerpts: [],
        indexedThrough: row.search_indexed_through,
        indexState:
          row.search_indexed_through !== null && row.search_indexed_through >= row.updated_at
            ? "current"
            : "stale",
        ftsRank: null,
      } satisfies ThreadKnowledgeSearchRow);

    for (const field of matchedIn) {
      if (!existing.matchedIn.includes(field)) existing.matchedIn.push(field);
    }
    if (row.fts_rank !== undefined && row.fts_rank !== null) {
      existing.ftsRank =
        existing.ftsRank === null
          ? Number(row.fts_rank)
          : Math.min(existing.ftsRank, Number(row.fts_rank));
    }
    const excerpt = excerptFromNativeRow(row);
    if (excerpt !== null && existing.excerpts.length < THREAD_SEARCH_MAX_EXCERPTS) {
      existing.excerpts.push(excerpt);
    }
    merged.set(row.id, existing);
  }

  private async metadataRows(input: SearchThreadsMetadataQuery): Promise<NativeThreadRow[]> {
    const pattern = likePattern(input.query);
    const structural = nativeThreadStructuralWhere(input, "metadata");
    const sqlText = `
      SELECT
        t.id,
        t.title,
        t.project_id,
        p.name AS project_name,
        t.source,
        t.archived_at,
        t.created_at,
        t.updated_at,
        t.last_message_preview,
        t.search_indexed_through,
        lower(t.title) LIKE lower(?) ESCAPE '^' AS title_match,
        lower(coalesce(p.name, '')) LIKE lower(?) ESCAPE '^' AS project_match,
        lower(t.last_message_preview) LIKE lower(?) ESCAPE '^' AS preview_match
      FROM thread_index t
      LEFT JOIN projects p ON p.id = t.project_id
      WHERE ${structural.whereSql}
        AND (
          lower(t.title) LIKE lower(?) ESCAPE '^'
          OR lower(coalesce(p.name, '')) LIKE lower(?) ESCAPE '^'
          OR lower(t.last_message_preview) LIKE lower(?) ESCAPE '^'
        )
      ORDER BY title_match DESC, project_match DESC, preview_match DESC, t.updated_at DESC, t.id DESC
      LIMIT ?
    `;
    const result = await this.binding
      .prepare(sqlText)
      .bind(
        pattern,
        pattern,
        pattern,
        ...structural.bindings,
        pattern,
        pattern,
        pattern,
        input.fetchLimit,
      )
      .all<NativeThreadRow>();
    return result.results ?? [];
  }

  private async metadataMatchesByThreadId(
    input: SearchThreadsMetadataQuery,
    threadIds: string[],
  ): Promise<Map<string, SearchThreadMatchField[]>> {
    const ids = Array.from(new Set(threadIds));
    if (ids.length === 0) return new Map();
    const pattern = likePattern(input.query);
    const targeted = nativeThreadTargetedWhere(input, ids);
    const sqlText = `
      SELECT
        t.id,
        lower(t.title) LIKE lower(?) ESCAPE '^' AS title_match,
        lower(coalesce(p.name, '')) LIKE lower(?) ESCAPE '^' AS project_match,
        lower(t.last_message_preview) LIKE lower(?) ESCAPE '^' AS preview_match
      FROM thread_index t
      LEFT JOIN projects p ON p.id = t.project_id
      WHERE ${targeted.whereSql}
    `;
    const result = await this.binding
      .prepare(sqlText)
      .bind(pattern, pattern, pattern, ...targeted.bindings)
      .all<Pick<NativeThreadRow, "id" | "title_match" | "project_match" | "preview_match">>();
    const matches = new Map<string, SearchThreadMatchField[]>();
    for (const row of result.results ?? []) {
      matches.set(row.id, [
        ...(truthy(row.title_match) ? (["title"] as const) : []),
        ...(truthy(row.project_match) ? (["project"] as const) : []),
        ...(truthy(row.preview_match) ? (["preview"] as const) : []),
      ]);
    }
    return matches;
  }

  private async ftsRows(input: SearchThreadsMetadataQuery): Promise<NativeThreadRow[]> {
    const structural = nativeThreadStructuralWhere(input, "fts");
    const sqlText = `
      WITH matched_messages AS (
        SELECT
          t.id,
          t.title,
          t.project_id,
          p.name AS project_name,
          t.source,
          t.archived_at,
          t.created_at,
          t.updated_at,
          t.last_message_preview,
          t.search_indexed_through,
          thread_search_fts.rank AS fts_rank,
          m.message_id,
          m.role,
          m.created_at AS message_created_at,
          snippet(thread_search_fts, 0, '', '', '…', 32) AS excerpt
        FROM thread_search_fts
        JOIN thread_search_messages m ON m.id = thread_search_fts.rowid
        JOIN thread_index t ON t.id = m.thread_id AND t.workspace_id = m.workspace_id
        LEFT JOIN projects p ON p.id = t.project_id
        WHERE thread_search_fts MATCH ?
          AND ${structural.whereSql}
      ),
      ranked_threads AS (
        SELECT
          id,
          min(fts_rank) AS fts_rank,
          max(updated_at) AS updated_at
        FROM matched_messages
        GROUP BY id
        ORDER BY fts_rank ASC, updated_at DESC, id DESC
        LIMIT ?
      ),
      ranked_messages AS (
        SELECT
          matched_messages.*,
          row_number() OVER (
            PARTITION BY matched_messages.id
            ORDER BY
              matched_messages.fts_rank ASC,
              matched_messages.message_created_at DESC,
              matched_messages.message_id DESC
          ) AS excerpt_rank
        FROM matched_messages
        JOIN ranked_threads ON ranked_threads.id = matched_messages.id
      )
      SELECT
        id,
        title,
        project_id,
        project_name,
        source,
        archived_at,
        created_at,
        updated_at,
        last_message_preview,
        search_indexed_through,
        fts_rank,
        message_id,
        role,
        message_created_at,
        excerpt
      FROM ranked_messages
      WHERE excerpt_rank <= ?
      ORDER BY fts_rank ASC, updated_at DESC, id DESC, excerpt_rank ASC
    `;
    const result = await this.binding
      .prepare(sqlText)
      .bind(input.matchQuery, ...structural.bindings, input.fetchLimit, THREAD_SEARCH_MAX_EXCERPTS)
      .all<NativeThreadRow>();
    return result.results ?? [];
  }

  private drizzleVisibilityClauses(
    input: Pick<
      ListThreadsQuery,
      "workspaceId" | "status" | "projectId" | "includeAutomata" | "interval"
    >,
  ): SQL[] {
    return [
      eq(threadIndex.workspaceId, input.workspaceId),
      ne(threadIndex.kind, "feedback"),
      input.includeAutomata ? undefined : eq(threadIndex.source, "manual"),
      input.status === "active" ? isNull(threadIndex.archivedAt) : undefined,
      input.status === "archived" ? isNotNull(threadIndex.archivedAt) : undefined,
      input.projectId === undefined ? undefined : eq(threadIndex.projectId, input.projectId),
      input.interval.since === undefined
        ? undefined
        : gte(threadIndex.updatedAt, input.interval.since),
      input.interval.until === undefined
        ? undefined
        : lt(threadIndex.updatedAt, input.interval.until),
    ].filter((clause): clause is SQL => clause !== undefined);
  }

  private drizzleListCursor(input: ListThreadsQuery): SQL[] {
    if (input.cursor === undefined) return [];
    return [
      or(
        lt(threadIndex.updatedAt, input.cursor.updatedAt),
        and(eq(threadIndex.updatedAt, input.cursor.updatedAt), lt(threadIndex.id, input.cursor.id)),
      ),
    ].filter((clause): clause is SQL => clause !== undefined);
  }
}

function nativeThreadStructuralWhere(
  input: SearchThreadsMetadataQuery,
  mode: "metadata" | "fts",
): { whereSql: string; bindings: unknown[] } {
  const clauses = ["t.workspace_id = ?", "t.kind <> 'feedback'"];
  const bindings: unknown[] = [input.workspaceId];

  if (!input.includeAutomata) clauses.push("t.source = 'manual'");
  if (input.status === "active") clauses.push("t.archived_at IS NULL");
  if (input.status === "archived") clauses.push("t.archived_at IS NOT NULL");
  if (input.projectId !== undefined) {
    clauses.push("t.project_id = ?");
    bindings.push(input.projectId);
  }

  if (input.interval.since !== undefined) {
    clauses.push(mode === "fts" ? "m.created_at >= ?" : "t.updated_at >= ?");
    bindings.push(input.interval.since);
  }
  if (input.interval.until !== undefined) {
    clauses.push(mode === "fts" ? "m.created_at < ?" : "t.updated_at < ?");
    bindings.push(input.interval.until);
  }

  return { whereSql: clauses.join(" AND "), bindings };
}

function nativeThreadTargetedWhere(
  input: SearchThreadsMetadataQuery,
  threadIds: string[],
): { whereSql: string; bindings: unknown[] } {
  const placeholders = threadIds.map(() => "?").join(", ");
  const clauses = ["t.workspace_id = ?", "t.kind <> 'feedback'", `t.id IN (${placeholders})`];
  const bindings: unknown[] = [input.workspaceId, ...threadIds];

  if (!input.includeAutomata) clauses.push("t.source = 'manual'");
  if (input.status === "active") clauses.push("t.archived_at IS NULL");
  if (input.status === "archived") clauses.push("t.archived_at IS NOT NULL");
  if (input.projectId !== undefined) {
    clauses.push("t.project_id = ?");
    bindings.push(input.projectId);
  }

  return { whereSql: clauses.join(" AND "), bindings };
}

function summaryFromNativeRow(row: NativeThreadRow): ThreadSummary {
  return {
    id: row.id,
    title: row.title,
    projectId: row.project_id,
    projectName: row.project_name,
    source: row.source,
    status: row.archived_at === null ? "active" : "archived",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    lastMessagePreview: row.last_message_preview,
  };
}

function excerptFromNativeRow(row: NativeThreadRow): SearchThreadExcerpt | null {
  if (
    row.message_id === undefined ||
    row.message_id === null ||
    row.role === undefined ||
    row.role === null ||
    row.excerpt === undefined ||
    row.excerpt === null
  ) {
    return null;
  }
  return {
    messageId: row.message_id,
    role: row.role,
    createdAt: row.message_created_at ?? null,
    text:
      row.excerpt.length > THREAD_SEARCH_EXCERPT_MAX_CHARS
        ? row.excerpt.slice(0, THREAD_SEARCH_EXCERPT_MAX_CHARS)
        : row.excerpt,
  };
}

function likePattern(input: string): string {
  return `%${input.replaceAll("^", "^^").replaceAll("%", "^%").replaceAll("_", "^_")}%`;
}

function truthy(value: number | boolean | null | undefined): boolean {
  return value === true || value === 1;
}

function hasMatch(row: ThreadKnowledgeSearchRow, field: SearchThreadMatchField): number {
  return row.matchedIn.includes(field) ? 1 : 0;
}

function searchResultCompare(a: ThreadKnowledgeSearchRow, b: ThreadKnowledgeSearchRow): number {
  for (const field of ["title", "project", "preview"] as const) {
    const delta = hasMatch(b, field) - hasMatch(a, field);
    if (delta !== 0) return delta;
  }
  const rankA = a.ftsRank ?? Number.POSITIVE_INFINITY;
  const rankB = b.ftsRank ?? Number.POSITIVE_INFINITY;
  if (rankA !== rankB) return rankA - rankB;
  if (a.thread.updatedAt !== b.thread.updatedAt) return b.thread.updatedAt - a.thread.updatedAt;
  return b.thread.id.localeCompare(a.thread.id);
}
