import type { UIMessage } from "ai";
import { appFetch } from "./lib/app-fetch";
import { errorFromResponse } from "./lib/http-error";
import type { ThreadSummary } from "./threads-api";

type FetchLike = typeof fetch;

export type FeedbackCategory = "bug" | "feature" | "general";

export interface FeedbackReportFields {
  category: FeedbackCategory;
  title: string;
  narrative: string;
  reproductionSteps: string[];
  expectedBehavior: string | null;
  actualBehavior: string | null;
  frequency: string | null;
  impact: string | null;
}

export interface FeedbackDiagnostics {
  schemaVersion: 1;
  route: string;
  build: string;
  browser: string;
  os: string;
  viewport: { width: number; height: number };
  theme: "light" | "dark";
  online: boolean;
}

export interface FeedbackDraftView {
  id: string;
  interviewId: string;
  fields: FeedbackReportFields;
  attachmentIds: string[];
  createdAt: number;
}

export interface FeedbackReportSummary {
  id: string;
  reporterUserId: string;
  workspaceId: string;
  threadId: string;
  interviewId: string;
  category: FeedbackCategory;
  title: string;
  submittedAt: number;
  attachmentCount: number;
  seen?: boolean;
}

export interface FeedbackReportDetail extends FeedbackReportSummary {
  fromMessageId: string;
  toMessageId: string;
  fields: FeedbackReportFields;
  diagnostics: FeedbackDiagnostics;
  attachmentIds: string[];
}

export interface FeedbackReportAttachmentView {
  id: string;
  url: string;
}

export interface FeedbackReportPage {
  reports: FeedbackReportSummary[];
  nextCursor: string | null;
}

export interface FeedbackReportDetailResponse {
  report: FeedbackReportDetail;
  transcript: unknown[];
  attachments: FeedbackReportAttachmentView[];
}

export class FeedbackRateLimitError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("Too many feedback messages. Wait a moment and try again.");
    this.name = "FeedbackRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

async function throwFeedbackError(res: Response, action: string): Promise<never> {
  if (res.status === 429) {
    const retryAfterSeconds = await readRetryAfterSeconds(res);
    throw new FeedbackRateLimitError(retryAfterSeconds);
  }
  throw await errorFromResponse(res, action);
}

async function readRetryAfterSeconds(res: Response): Promise<number> {
  const fromHeader = Number(res.headers.get("Retry-After"));
  if (Number.isFinite(fromHeader) && fromHeader >= 0) return Math.ceil(fromHeader);
  try {
    const body = (await res.clone().json()) as { retryAfterSeconds?: unknown };
    const fromBody = Number(body.retryAfterSeconds);
    if (Number.isFinite(fromBody) && fromBody >= 0) return Math.ceil(fromBody);
  } catch {
    // Fall through to a conservative UI fallback.
  }
  return 60;
}

export async function getOrCreateFeedbackThread(
  fetchImpl: FetchLike = appFetch,
): Promise<ThreadSummary> {
  const res = await fetchImpl("/api/feedback/thread", {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) await throwFeedbackError(res, "open feedback");
  const body = (await res.json()) as { thread: ThreadSummary };
  return body.thread;
}

export async function sendFeedbackMessage(
  input: { threadId: string; message: UIMessage },
  fetchImpl: FetchLike = appFetch,
): Promise<void> {
  const res = await fetchImpl("/api/feedback/messages", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) await throwFeedbackError(res, "send feedback");
}

export async function createManualFeedbackDraft(
  input: {
    threadId: string;
    interviewId?: string;
    fromMessageId?: string;
    fields: FeedbackReportFields;
    attachmentIds: string[];
  },
  fetchImpl: FetchLike = appFetch,
): Promise<FeedbackDraftView> {
  const res = await fetchImpl("/api/feedback/drafts", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) await throwFeedbackError(res, "save feedback draft");
  const body = (await res.json()) as { draft: FeedbackDraftView };
  return body.draft;
}

export async function submitFeedbackDraft(
  input: { draftId: string; idempotencyKey: string; diagnostics: FeedbackDiagnostics },
  fetchImpl: FetchLike = appFetch,
): Promise<{ created: boolean; report: FeedbackReportDetail }> {
  const res = await fetchImpl(`/api/feedback/drafts/${encodeURIComponent(input.draftId)}/submit`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      idempotencyKey: input.idempotencyKey,
      diagnostics: input.diagnostics,
    }),
  });
  if (!res.ok) await throwFeedbackError(res, "submit feedback");
  return (await res.json()) as { created: boolean; report: FeedbackReportDetail };
}

export async function listFeedbackReports(
  options: { limit?: number; cursor?: string } = {},
  fetchImpl: FetchLike = appFetch,
): Promise<FeedbackReportPage> {
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.cursor) params.set("cursor", options.cursor);
  const query = params.size === 0 ? "" : `?${params.toString()}`;
  const res = await fetchImpl(`/api/admin/feedback${query}`, { credentials: "include" });
  if (!res.ok) await throwFeedbackError(res, "load feedback reports");
  return (await res.json()) as FeedbackReportPage;
}

export async function getFeedbackReport(
  reportId: string,
  fetchImpl: FetchLike = appFetch,
): Promise<FeedbackReportDetailResponse> {
  const res = await fetchImpl(`/api/admin/feedback/${encodeURIComponent(reportId)}`, {
    credentials: "include",
  });
  if (!res.ok) await throwFeedbackError(res, "load this feedback report");
  return (await res.json()) as FeedbackReportDetailResponse;
}

export async function markFeedbackReportSeen(
  reportId: string,
  fetchImpl: FetchLike = appFetch,
): Promise<void> {
  const res = await fetchImpl(`/api/admin/feedback/${encodeURIComponent(reportId)}/seen`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) await throwFeedbackError(res, "mark this feedback report as seen");
}
