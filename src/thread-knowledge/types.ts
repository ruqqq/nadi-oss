export const THREAD_READ_MAX_MESSAGES = 50;
export const THREAD_READ_MAX_TEXT_BYTES = 32 * 1024;
export const THREAD_LIST_DEFAULT_LIMIT = 20;
export const THREAD_LIST_MAX_LIMIT = 50;
export const THREAD_SEARCH_DEFAULT_LIMIT = 10;
export const THREAD_SEARCH_MAX_LIMIT = 25;
export const THREAD_SEARCH_MAX_OFFSET = 500;
export const THREAD_SEARCH_MAX_QUERY_CHARS = 500;
export const THREAD_SEARCH_MAX_QUERY_TOKENS = 20;
export const THREAD_SEARCH_MAX_EXCERPTS = 3;
export const THREAD_SEARCH_EXCERPT_MAX_CHARS = 500;
export const THREAD_LAST_MESSAGE_PREVIEW_CHARS = 200;
export const THREAD_SOURCE_SCAN_MAX_MESSAGES = 2_000;
export const THREAD_SOURCE_SCAN_MAX_BYTES = 2 * 1024 * 1024;
export const THREAD_PROJECTION_DIGEST_PAGE = 200;
export const THREAD_PROJECTION_DOCUMENT_BATCH = 25;
export const THREAD_PROJECTION_MAX_MESSAGES = 5_000;
export const THREAD_PROJECTION_MAX_BYTES = 8 * 1024 * 1024;

export type ThreadKnowledgeErrorCode =
  | "invalid_input"
  | "invalid_cursor"
  | "not_found"
  | "search_unavailable"
  | "source_unavailable";

export type ThreadKnowledgeError = {
  ok: false;
  code: ThreadKnowledgeErrorCode;
  message: string;
};

export type DateInterval = { since?: number; until?: number };

export type ThreadProseMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: number | null;
};

export type ThreadSearchDigest = {
  messageId: string;
  sourceHash: string;
  indexable: boolean;
};

export type ThreadSearchDocument = {
  message: ThreadProseMessage;
  sourceHash: string;
};

export interface ActiveTranscriptRpc {
  readThreadProsePage(input: InternalReadRequest): Promise<InternalReadResult>;
  grepThreadProse(input: InternalGrepRequest): Promise<InternalGrepResult>;
  listThreadSearchDigests(input: { afterPosition?: number; limit: number }): Promise<{
    digests: ThreadSearchDigest[];
    nextPosition?: number;
    lastMessagePreview: string;
  }>;
  getThreadSearchDocuments(messageIds: string[]): Promise<ThreadSearchDocument[]>;
}

export type ThreadSummary = {
  id: string;
  title: string;
  projectId: string | null;
  projectName: string | null;
  source: "manual" | "automaton";
  status: "active" | "archived";
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  lastMessagePreview: string;
};

export type RawTranscriptStat = {
  id: string;
  position: number;
  bytes: number;
};

export interface TranscriptSource {
  listStats(input: {
    afterPosition?: number;
    order: ThreadOrder;
    limit: number;
  }): Promise<{ stats: RawTranscriptStat[]; nextPosition?: number }>;
  getMessage(id: string): Promise<unknown | null>;
}

export type ThreadKnowledgeScope = {
  workspaceId: string;
  callerThreadId: string;
};

export type ThreadStatusFilter = "active" | "archived" | "all";
export type ThreadOrder = "chronological" | "reverse";

export type ListThreadsInput = {
  since?: string;
  until?: string;
  status?: ThreadStatusFilter;
  projectId?: string;
  includeAutomata?: boolean;
  limit?: number;
  cursor?: string;
};

export type ListThreadsResult = {
  threads: ThreadSummary[];
  nextCursor?: string;
};

export type SearchThreadMatchField = "title" | "project" | "preview" | "message";

export type SearchThreadExcerpt = {
  messageId: string;
  role: "user" | "assistant";
  createdAt: number | null;
  text: string;
};

export type SearchThreadResultItem = {
  thread: ThreadSummary;
  matchedIn: SearchThreadMatchField[];
  excerpts: SearchThreadExcerpt[];
  indexedThrough: number | null;
  indexState: "current" | "stale";
};

export type SearchThreadsIndexStatus = {
  pendingThreadCount: number;
  oldestPendingUpdatedAt?: number;
};

export type SearchThreadsInput = {
  query: string;
  since?: string;
  until?: string;
  status?: ThreadStatusFilter;
  projectId?: string;
  includeAutomata?: boolean;
  limit?: number;
  cursor?: string;
};

export type SearchThreadsResult = {
  results: SearchThreadResultItem[];
  indexStatus: SearchThreadsIndexStatus;
  nextCursor?: string;
};

export type ReadThreadLimitReason = "message_count" | "bytes" | "source_scan";

export type InternalReadRequest = {
  threadId: string;
  since?: string;
  until?: string;
  includeAutomata?: boolean;
  order?: ThreadOrder;
  limit?: number;
  cursor?: string;
};

export type InternalReadResult = {
  messages: ThreadProseMessage[];
  omittedPartCount: number;
  limited: boolean;
  limitReason?: ReadThreadLimitReason;
  nextCursor?: string;
};

export type ReadThreadInput = {
  threadId: string;
  since?: string;
  until?: string;
  includeAutomata?: boolean;
  order?: ThreadOrder;
  limit?: number;
  cursor?: string;
};

export type ReadThreadResult = {
  thread: ThreadSummary;
  messages: ThreadProseMessage[];
  omittedPartCount: number;
  limited: boolean;
  limitReason?: ReadThreadLimitReason;
  nextCursor?: string;
};

export type GrepThreadMatch = {
  messageId: string;
  role: "user" | "assistant";
  createdAt: number | null;
  line: number;
  text: string;
  before: string[];
  after: string[];
};

export type GrepThreadInput = {
  threadId: string;
  pattern: string;
  since?: string;
  until?: string;
  includeAutomata?: boolean;
  caseSensitive?: boolean;
  contextLines?: number;
  maxMatches?: number;
};

export type InternalGrepRequest = {
  threadId: string;
  pattern: string;
  since?: string;
  until?: string;
  includeAutomata?: boolean;
  caseSensitive?: boolean;
  contextLines?: number;
  maxMatches?: number;
};

export type InternalGrepResult = {
  matches: GrepThreadMatch[];
  omittedPartCount: number;
  limited: boolean;
  limitReason?: string;
};

export type GrepThreadResult = {
  thread: ThreadSummary;
  matches: GrepThreadMatch[];
  limited: boolean;
  limitReason?: string;
};

export type ThreadKnowledgeResult<T> = T | ThreadKnowledgeError;
