import type { Env } from "../env";
import { registryDb } from "../db/client";
import { ArchivedMessageRepository } from "../db/repositories/archived-messages";
import {
  ThreadKnowledgeRepository,
  type EligibleThread,
  type PendingThreadCount,
} from "../db/repositories/thread-knowledge";
import { activeTranscriptRpc, hasLiveTranscript } from "./adapters/active-transcript";
import { ArchivedTranscriptAdapter } from "./adapters/archived-transcript";
import { decodeKnowledgeCursor, encodeKnowledgeCursor, fingerprintKnowledgeQuery } from "./cursors";
import { parseDateInterval } from "./date-interval";
import { buildFtsMatchQuery } from "./fts-query";
import { grepTranscript, readTranscriptPage } from "./transcript-reader";
import type {
  DateInterval,
  GrepThreadInput,
  GrepThreadResult,
  InternalGrepRequest,
  InternalReadRequest,
  ListThreadsInput,
  ListThreadsResult,
  ReadThreadInput,
  ReadThreadResult,
  SearchThreadsInput,
  SearchThreadsResult,
  ThreadKnowledgeError,
  ThreadKnowledgeResult,
  ThreadOrder,
  ThreadStatusFilter,
} from "./types";
import {
  THREAD_LIST_DEFAULT_LIMIT,
  THREAD_LIST_MAX_LIMIT,
  THREAD_READ_MAX_MESSAGES,
  THREAD_SEARCH_DEFAULT_LIMIT,
  THREAD_SEARCH_MAX_LIMIT,
  THREAD_SEARCH_MAX_OFFSET,
} from "./types";

type ServiceDeps = {
  env: Env;
  db: ReturnType<typeof registryDb>;
  binding: D1Database;
  scope: {
    workspaceId: string;
    callerThreadId: string;
  };
};

type NormalizedListInput = {
  status: ThreadStatusFilter;
  projectId?: string;
  includeAutomata: boolean;
  interval: DateInterval;
  limit: number;
  cursor?: { updatedAt: number; id: string };
  fingerprint: string;
};

type NormalizedSearchInput = {
  status: ThreadStatusFilter;
  projectId?: string;
  includeAutomata: boolean;
  interval: DateInterval;
  limit: number;
  offset: number;
  fingerprint: string;
  matchQuery: string;
};

const NOT_FOUND: ThreadKnowledgeError = {
  ok: false,
  code: "not_found",
  message: "Thread not found.",
};

export class ThreadKnowledgeService {
  private readonly repository: ThreadKnowledgeRepository;

  constructor(private readonly deps: ServiceDeps) {
    this.repository = new ThreadKnowledgeRepository(deps.db, deps.binding);
  }

  async listThreads(input: ListThreadsInput): Promise<ThreadKnowledgeResult<ListThreadsResult>> {
    try {
      const normalized = normalizeListInput(input);
      const rows = await this.repository.list({
        workspaceId: this.deps.scope.workspaceId,
        status: normalized.status,
        includeAutomata: normalized.includeAutomata,
        interval: normalized.interval,
        limit: normalized.limit,
        ...(normalized.projectId === undefined ? {} : { projectId: normalized.projectId }),
        ...(normalized.cursor === undefined ? {} : { cursor: normalized.cursor }),
      });
      const threads = rows.slice(0, normalized.limit);
      const last = threads[threads.length - 1];
      return {
        threads,
        ...(rows.length > normalized.limit && last !== undefined
          ? {
              nextCursor: encodeKnowledgeCursor({
                version: 1,
                operation: "list",
                fingerprint: normalized.fingerprint,
                updatedAt: last.updatedAt,
                id: last.id,
              }),
            }
          : {}),
      };
    } catch (error) {
      return mapServiceError(error, "metadata");
    }
  }

  async searchThreads(
    input: SearchThreadsInput,
  ): Promise<ThreadKnowledgeResult<SearchThreadsResult>> {
    try {
      const normalized = normalizeSearchInput(input);
      const fetchLimit = normalized.offset + normalized.limit + 1;
      const [rows, indexStatus] = await Promise.all([
        this.repository.searchMetadata({
          workspaceId: this.deps.scope.workspaceId,
          query: input.query,
          matchQuery: normalized.matchQuery,
          status: normalized.status,
          includeAutomata: normalized.includeAutomata,
          interval: normalized.interval,
          fetchLimit,
          ...(normalized.projectId === undefined ? {} : { projectId: normalized.projectId }),
        }),
        this.pendingStatus(normalized),
      ]);
      const results = rows.slice(normalized.offset, normalized.offset + normalized.limit);
      const nextOffset = normalized.offset + normalized.limit;
      return {
        results,
        indexStatus,
        ...(rows.length > nextOffset && nextOffset <= THREAD_SEARCH_MAX_OFFSET
          ? {
              nextCursor: encodeKnowledgeCursor({
                version: 1,
                operation: "search",
                fingerprint: normalized.fingerprint,
                offset: nextOffset,
              }),
            }
          : {}),
      };
    } catch (error) {
      return mapServiceError(error, "search");
    }
  }

  async readThread(input: ReadThreadInput): Promise<ThreadKnowledgeResult<ReadThreadResult>> {
    try {
      const normalized = normalizeReadInput(input);
      const thread = await this.loadEligible(input.threadId, normalized.includeAutomata);
      if (thread === null) return NOT_FOUND;
      const request: InternalReadRequest = {
        ...input,
        includeAutomata: normalized.includeAutomata,
        order: normalized.order,
        limit: normalized.limit,
      };
      const result = hasLiveTranscript(thread)
        ? await this.readActive(thread, request)
        : await readTranscriptPage(this.archivedAdapter(thread.id), request);
      return {
        thread,
        messages: result.messages,
        omittedPartCount: result.omittedPartCount,
        limited: result.limited,
        ...(result.limitReason === undefined ? {} : { limitReason: result.limitReason }),
        ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
      };
    } catch (error) {
      return mapServiceError(error, "source");
    }
  }

  async grepThread(input: GrepThreadInput): Promise<ThreadKnowledgeResult<GrepThreadResult>> {
    try {
      const normalized = normalizeGrepInput(input);
      const thread = await this.loadEligible(input.threadId, normalized.includeAutomata);
      if (thread === null) return NOT_FOUND;
      const request: InternalGrepRequest = {
        ...input,
        includeAutomata: normalized.includeAutomata,
      };
      const result = hasLiveTranscript(thread)
        ? await this.grepActive(thread, request)
        : await grepTranscript(this.archivedAdapter(thread.id), request);
      return {
        thread,
        matches: result.matches,
        limited: result.limited,
        ...(result.limitReason === undefined ? {} : { limitReason: result.limitReason }),
      };
    } catch (error) {
      return mapServiceError(error, "source");
    }
  }

  private async pendingStatus(input: NormalizedSearchInput): Promise<PendingThreadCount> {
    return this.repository.countPending({
      workspaceId: this.deps.scope.workspaceId,
      status: input.status,
      includeAutomata: input.includeAutomata,
      interval: input.interval,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    });
  }

  private async loadEligible(
    threadId: string,
    includeAutomata: boolean,
  ): Promise<EligibleThread | null> {
    return this.repository.loadEligible({
      workspaceId: this.deps.scope.workspaceId,
      threadId,
      includeAutomata,
    });
  }

  private async readActive(thread: EligibleThread, input: InternalReadRequest) {
    const rpc = await activeTranscriptRpc(this.deps.env, { id: thread.id });
    return rpc.readThreadProsePage(input);
  }

  private async grepActive(thread: EligibleThread, input: InternalGrepRequest) {
    const rpc = await activeTranscriptRpc(this.deps.env, { id: thread.id });
    return rpc.grepThreadProse(input);
  }

  private archivedAdapter(threadId: string) {
    return new ArchivedTranscriptAdapter(new ArchivedMessageRepository(this.deps.db), threadId);
  }
}

function normalizeStatus(status: ThreadStatusFilter | undefined): ThreadStatusFilter {
  if (status === undefined) return "all";
  if (status === "active" || status === "archived" || status === "all") return status;
  throw new Error("invalid_input");
}

function normalizeOrder(order: ThreadOrder | undefined): ThreadOrder {
  if (order === undefined) return "chronological";
  if (order === "chronological" || order === "reverse") return order;
  throw new Error("invalid_input");
}

function normalizeLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) throw new Error("invalid_input");
  return Math.min(value, max);
}

function normalizeListInput(input: ListThreadsInput): NormalizedListInput {
  const status = normalizeStatus(input.status);
  const interval = parseDateInterval(input);
  const includeAutomata = input.includeAutomata ?? false;
  const fingerprint = fingerprintKnowledgeQuery({
    operation: "list",
    status,
    includeAutomata,
    ...interval,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
  });
  const decoded = decodeOptionalCursor(input.cursor, fingerprint, "list");
  return {
    status,
    includeAutomata,
    interval,
    limit: normalizeLimit(input.limit, THREAD_LIST_DEFAULT_LIMIT, THREAD_LIST_MAX_LIMIT),
    fingerprint,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    ...(decoded?.operation === "list"
      ? { cursor: { updatedAt: decoded.updatedAt, id: decoded.id } }
      : {}),
  };
}

function normalizeSearchInput(input: SearchThreadsInput): NormalizedSearchInput {
  const status = normalizeStatus(input.status);
  const interval = parseDateInterval(input);
  const includeAutomata = input.includeAutomata ?? false;
  const matchQuery = buildFtsMatchQuery(input.query);
  const fingerprint = fingerprintKnowledgeQuery({
    operation: "search",
    query: input.query,
    status,
    includeAutomata,
    ...interval,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
  });
  const decoded = decodeOptionalCursor(input.cursor, fingerprint, "search");
  const offset = decoded?.operation === "search" ? decoded.offset : 0;
  if (offset > THREAD_SEARCH_MAX_OFFSET) throw new Error("invalid_cursor");
  return {
    status,
    includeAutomata,
    interval,
    limit: normalizeLimit(input.limit, THREAD_SEARCH_DEFAULT_LIMIT, THREAD_SEARCH_MAX_LIMIT),
    offset,
    fingerprint,
    matchQuery,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
  };
}

function normalizeReadInput(input: ReadThreadInput): {
  includeAutomata: boolean;
  order: ThreadOrder;
  limit: number;
} {
  const interval = parseDateInterval(input);
  const includeAutomata = input.includeAutomata ?? false;
  const order = normalizeOrder(input.order);
  const fingerprint = fingerprintKnowledgeQuery({
    operation: "read",
    threadId: input.threadId,
    includeAutomata,
    order,
    ...interval,
  });
  decodeOptionalCursor(input.cursor, fingerprint, "read");
  return {
    includeAutomata,
    order,
    limit: normalizeLimit(input.limit, 20, THREAD_READ_MAX_MESSAGES),
  };
}

function normalizeGrepInput(input: GrepThreadInput): { includeAutomata: boolean } {
  parseDateInterval(input);
  if (typeof input.pattern !== "string" || input.pattern === "") {
    throw new Error("invalid_input");
  }
  return { includeAutomata: input.includeAutomata ?? false };
}

function decodeOptionalCursor(
  cursor: string | undefined,
  fingerprint: string,
  operation: "list" | "search" | "read",
) {
  if (cursor === undefined) return undefined;
  const decoded = decodeKnowledgeCursor(cursor, fingerprint);
  if (decoded?.operation !== operation) throw new Error("invalid_cursor");
  return decoded;
}

const INVALID_INPUT_MESSAGES: Record<string, string> = {
  invalid_input: "Invalid thread knowledge input.",
  invalid_since: "`since` must be an absolute ISO-8601 timestamp, e.g. 2026-07-31T00:00:00Z.",
  invalid_until: "`until` must be an absolute ISO-8601 timestamp, e.g. 2026-07-31T00:00:00Z.",
  invalid_interval: "`since` must be earlier than `until`; the interval is [since, until).",
  empty_search_query:
    "`query` must contain at least one word or number. Wildcards and globs are not supported — `*` matches nothing. Use list_threads to browse without a search term.",
  search_query_too_long: "`query` is too long; use a few distinctive terms instead of a passage.",
  sandbox_grep_pattern_too_long: "`pattern` is too long.",
};

function mapServiceError(
  error: unknown,
  context: "metadata" | "search" | "source",
): ThreadKnowledgeError {
  const message = error instanceof Error ? error.message : "";
  // A rejection the model cannot act on costs it the whole task: a live run
  // burned six calls against "Invalid thread knowledge input." and then gave up
  // and asked the user. Each message below names the offending argument and the
  // recovery, so a retry can differ from the call that failed.
  const invalidInput = INVALID_INPUT_MESSAGES[message];
  if (invalidInput !== undefined || error instanceof SyntaxError) {
    return {
      ok: false,
      code: "invalid_input",
      message: invalidInput ?? "Invalid thread knowledge input.",
    };
  }
  if (message === "invalid_cursor") {
    return {
      ok: false,
      code: "invalid_cursor",
      message:
        "Invalid or expired cursor. Omit `cursor` entirely to start from the first page. A cursor is only valid when replayed against a call whose every other argument is unchanged.",
    };
  }
  if (context === "search") {
    return {
      ok: false,
      code: "search_unavailable",
      message: "Thread search is temporarily unavailable; retry later or use list_threads.",
    };
  }
  return {
    ok: false,
    code: "source_unavailable",
    message:
      context === "metadata"
        ? "Thread metadata is temporarily unavailable."
        : "Thread transcript is temporarily unavailable; retry later.",
  };
}
