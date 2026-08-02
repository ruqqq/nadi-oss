import type { ThreadSummary } from "../threads-api";

export function isAutomatonThreadHidden(t: ThreadSummary): boolean {
  if (t.source !== "automaton") return false;
  if (t.automatonNotifyMode !== "failures_only") return false;
  const needsAttention = t.attentionRequiredAt != null || t.activityStatus === "failed";
  return !(needsAttention && t.outcomeDismissedAt == null);
}

export function mergeThread(threads: ThreadSummary[], thread: ThreadSummary): ThreadSummary[] {
  const withoutThread = threads.filter((item) => item.threadId !== thread.threadId);
  // Tie-break on threadId when updatedAt is equal, matching the server's
  // (updatedAt desc, id desc) order — without it, folding tied rows one at a
  // time (mergeThreads, or the offline self-merge in refreshActiveThreads)
  // reverses their relative order on every call.
  return [thread, ...withoutThread].sort(
    (a, b) => b.updatedAt - a.updatedAt || b.threadId.localeCompare(a.threadId),
  );
}

/**
 * Fold a fetched page into an existing thread array — dedupe by threadId
 * (the page's version wins), sorted by updatedAt desc. Used wherever a
 * page-one (or any partial) fetch must ADD to the shared active-threads
 * array rather than replace it: a replace would discard whatever other
 * pages/surfaces had already merged in.
 */
export function mergeThreads(threads: ThreadSummary[], page: ThreadSummary[]): ThreadSummary[] {
  return page.reduce((acc, thread) => mergeThread(acc, thread), threads);
}

export function mergeThreadsExcluding(
  threads: ThreadSummary[],
  page: ThreadSummary[],
  excludedIds: ReadonlySet<string>,
): ThreadSummary[] {
  return mergeThreads(
    threads.filter((thread) => !excludedIds.has(thread.threadId)),
    page.filter((thread) => !excludedIds.has(thread.threadId)),
  );
}

export type UserEvent =
  | { type: "thread.created"; thread: ThreadSummary }
  /**
   * `preview` rides along only on a lifecycle broadcast (finished / failed /
   * needs approval) and carries the same excerpt the push would have used, so
   * the in-app notice can say the same thing. Deliberately not read off the
   * thread row: `lastMessagePreview` is written by the search projector from
   * `ctx.waitUntil`, racing this broadcast, and at this instant is often still
   * the user's own last message.
   */
  | { type: "thread.updated"; thread: ThreadSummary; preview?: string }
  | { type: "thread.archived"; thread: ThreadSummary }
  | { type: "thread.deleted"; threadId: string; workspaceId: string }
  | { type: "feedback.report.created"; reportId: string; submittedAt: number };

export function parseUserEvent(raw: string): UserEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || !("type" in value)) return null;
  const type = (value as { type: unknown }).type;
  if (type === "thread.created" || type === "thread.updated" || type === "thread.archived") {
    const thread = (value as { thread?: unknown }).thread;
    if (!thread || typeof thread !== "object") return null;
    if (typeof (thread as { threadId?: unknown }).threadId !== "string") return null;
    if (
      ("projectId" in thread &&
        (thread as { projectId?: unknown }).projectId !== null &&
        typeof (thread as { projectId?: unknown }).projectId !== "string") ||
      ("projectName" in thread &&
        (thread as { projectName?: unknown }).projectName !== null &&
        typeof (thread as { projectName?: unknown }).projectName !== "string") ||
      ("repositorySnapshotCount" in thread &&
        typeof (thread as { repositorySnapshotCount?: unknown }).repositorySnapshotCount !==
          "number")
    ) {
      return null;
    }
    // A malformed preview must not reach the toast as a non-string.
    if (
      "preview" in value &&
      (value as { preview?: unknown }).preview !== undefined &&
      typeof (value as { preview?: unknown }).preview !== "string"
    ) {
      return null;
    }
    return value as UserEvent;
  }
  if (type === "thread.deleted") {
    if (typeof (value as { threadId?: unknown }).threadId !== "string") return null;
    return value as UserEvent;
  }
  if (type === "feedback.report.created") {
    if (typeof (value as { reportId?: unknown }).reportId !== "string") return null;
    if (typeof (value as { submittedAt?: unknown }).submittedAt !== "number") return null;
    return value as UserEvent;
  }
  return null;
}

export function applyUserEvent(threads: ThreadSummary[], event: UserEvent): ThreadSummary[] {
  switch (event.type) {
    case "thread.created":
    case "thread.updated":
      return isAutomatonThreadHidden(event.thread)
        ? threads.filter((t) => t.threadId !== event.thread.threadId)
        : mergeThread(threads, event.thread);
    case "thread.archived":
      return threads.filter((t) => t.threadId !== event.thread.threadId);
    case "thread.deleted":
      return threads.filter((t) => t.threadId !== event.threadId);
    case "feedback.report.created":
      return threads;
  }
}
