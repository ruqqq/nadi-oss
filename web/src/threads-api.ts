import type { UIMessage } from "ai";
import { appFetch } from "./lib/app-fetch";
import type { ModelInputModality, ReasoningEffort, SettingsProvider } from "./settings-api";

export type ThreadActivityStatus = "idle" | "running" | "attention_required" | "failed";
export type ThreadUnreadOutcome = "completed" | "failed" | null;

export interface ThreadSummary {
  threadId: string;
  kind: "regular" | "feedback";
  workspaceId: string;
  agentId: string;
  provider: string;
  model: string;
  modelInputModalities: ModelInputModality[];
  showReasoning: boolean;
  reasoningEffort: ReasoningEffort;
  /** `null` = unknown — never conflate with false. */
  modelSupportsReasoning: boolean | null;
  runtime: "legacy" | "think";
  activityStatus?: ThreadActivityStatus;
  currentTurnStartedAt?: number | null;
  attentionRequiredAt?: number | null;
  title: string;
  source: "manual" | "automaton";
  lastMessagePreview: string;
  unreadOutcome?: ThreadUnreadOutcome;
  unreadOutcomeAt?: number | null;
  lastSeenAt?: number | null;
  archivedAt: number | null;
  readOnly: boolean;
  status: "active" | "archived";
  projectId: string | null;
  projectName: string | null;
  workbenchId: string | null;
  workbenchName: string | null;
  /** True while a workbench switch is deferred: `workbenchId` is the intent,
   * but `resourceProfile` still reflects the OLD workbench until the agent
   * confirms and the switch commits. */
  workbenchSwitchPending: boolean;
  /** The sandbox size actually in effect (frozen snapshot, not the live
   * workbench — those can diverge while `workbenchSwitchPending` is true). */
  resourceProfile: "small" | "medium";
  automatonId: string | null;
  automatonName: string | null;
  automatonNotifyMode: "all" | "failures_only" | null;
  outcomeDismissedAt: number | null;
  /** Set while the user has dismissed this thread from the sidebar rail. Only
   * the rail reads it, and only while `recentDismissedAt >= updatedAt` — see
   * `lib/thread-dismissal.ts`. Required, not optional: an optional field would
   * let a fixture omit it and render a state the server can no longer produce. */
  recentDismissedAt: number | null;
  repositorySnapshotCount: number;
  lastContextTokens: number | null;
  lastContextWindow: number | null;
  /** The compaction trigger the last turn ran with. NULL = no warning threshold. */
  lastCompactAfterTokens: number | null;
  createdAt: number;
  updatedAt: number;
}

import { errorFromResponse } from "./lib/http-error";
import type { ArchivedSummary } from "./lib/archived-compaction";

type FetchLike = typeof fetch;

export type CreateThreadInput = {
  provider?: SettingsProvider;
  model?: string;
  modelInputModalities?: ModelInputModality[];
  showReasoning?: boolean;
  reasoningEffort?: ReasoningEffort;
  /** `null` clears the capability back to unknown. */
  modelSupportsReasoning?: boolean | null;
  projectId?: string | null;
  workbenchId?: string | null;
};

export type ThreadListStatus = "active" | "archived" | "all";
export type ThreadProjectListFilter = "all" | "unassigned" | string | null;

export async function listThreads(
  fetchImpl: FetchLike = appFetch,
  status: ThreadListStatus = "active",
  project: ThreadProjectListFilter = "all",
  options: { limit?: number; cursor?: string; q?: string } = {},
): Promise<{ threads: ThreadSummary[]; nextCursor: string | null }> {
  const params: string[] = [];
  if (status !== "active") params.push(`status=${encodeURIComponent(status)}`);
  if (project === "unassigned" || project === null) {
    params.push("project=unassigned");
  } else if (typeof project === "string" && project !== "all") {
    params.push(`projectId=${encodeURIComponent(project)}`);
  }
  if (options.limit !== undefined) params.push(`limit=${encodeURIComponent(options.limit)}`);
  if (options.cursor !== undefined) params.push(`cursor=${encodeURIComponent(options.cursor)}`);
  if (options.q !== undefined) params.push(`q=${encodeURIComponent(options.q)}`);
  const query = params.length === 0 ? "" : `?${params.join("&")}`;
  const res = await fetchImpl(`/api/threads${query}`, {
    credentials: "include",
  });
  if (!res.ok) {
    throw await errorFromResponse(res, "load your chats");
  }
  const body = (await res.json()) as { threads: ThreadSummary[]; nextCursor?: string | null };
  return { threads: body.threads, nextCursor: body.nextCursor ?? null };
}

export async function reconcileThreads(
  threadIds: string[],
  fetchImpl: FetchLike = appFetch,
): Promise<string[]> {
  const res = await fetchImpl("/api/threads/reconcile", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadIds }),
  });
  if (!res.ok) throw await errorFromResponse(res, "sync your chats");
  const body = (await res.json()) as { activeThreadIds: string[] };
  return body.activeThreadIds;
}

export async function getThread(
  threadId: string,
  fetchImpl: FetchLike = appFetch,
): Promise<ThreadSummary> {
  const res = await fetchImpl(`/api/threads/${encodeURIComponent(threadId)}`, {
    credentials: "include",
  });
  if (!res.ok) {
    throw await errorFromResponse(res, "open this chat");
  }
  const body = (await res.json()) as { thread: ThreadSummary };
  return body.thread;
}

/**
 * Like getThread, but returns null instead of throwing on 404.
 * Used by the notification routing flow to distinguish "thread deleted"
 * from a network error.
 */
export async function getThreadOrNull(
  threadId: string,
  fetchImpl: FetchLike = appFetch,
): Promise<ThreadSummary | null> {
  const res = await fetchImpl(`/api/threads/${encodeURIComponent(threadId)}`, {
    credentials: "include",
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw await errorFromResponse(res, "open this chat");
  }
  const body = (await res.json()) as { thread: ThreadSummary };
  return body.thread;
}

export async function archiveThread(
  threadId: string,
  fetchImpl: FetchLike = appFetch,
): Promise<ThreadSummary> {
  const res = await fetchImpl(`/api/threads/${encodeURIComponent(threadId)}/archive`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) {
    // No special-case for 409: the server sends a distinct, human-readable reason
    // for each one ("Thread is responding…" vs "This thread has no messages to
    // archive; delete it instead"), and errorFromResponse surfaces it. Hardcoding
    // "still responding" here told a user archiving an EMPTY thread something
    // simply untrue.
    throw await errorFromResponse(res, "archive this chat");
  }
  const body = (await res.json()) as { thread: ThreadSummary };
  return body.thread;
}

export async function deleteThread(
  threadId: string,
  fetchImpl: FetchLike = appFetch,
): Promise<void> {
  const res = await fetchImpl(`/api/threads/${encodeURIComponent(threadId)}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) {
    // The DO returns 409 while a turn is still streaming (see thread-routes.ts).
    if (res.status === 409) {
      throw new Error("Can't delete this thread while it's still responding.");
    }
    throw await errorFromResponse(res, "delete this chat");
  }
}

export async function dismissThreadOutcome(
  threadId: string,
  fetchImpl: FetchLike = appFetch,
): Promise<void> {
  const res = await fetchImpl(`/api/threads/${encodeURIComponent(threadId)}/dismiss-outcome`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw await errorFromResponse(res, "dismiss this run");
}

export interface CompactThreadResult {
  compacted: boolean;
  message: string;
}

export interface ThreadCompactionStatus {
  phase: "idle" | "compacting";
}

export async function compactThread(
  threadId: string,
  fetchImpl: FetchLike = appFetch,
): Promise<CompactThreadResult> {
  const res = await fetchImpl(`/api/threads/${encodeURIComponent(threadId)}/compact`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) {
    if (res.status === 409) {
      throw new Error("Can't compact this thread while it's responding.");
    }
    throw await errorFromResponse(res, "compact this chat");
  }
  return (await res.json()) as CompactThreadResult;
}

export async function getThreadCompactionStatus(
  threadId: string,
  fetchImpl: FetchLike = appFetch,
): Promise<ThreadCompactionStatus> {
  const res = await fetchImpl(`/api/threads/${encodeURIComponent(threadId)}/compact/status`, {
    credentials: "include",
  });
  if (!res.ok) {
    throw await errorFromResponse(res, "check compaction status");
  }
  return (await res.json()) as ThreadCompactionStatus;
}

export async function markThreadSeen(
  threadId: string,
  fetchImpl: FetchLike = appFetch,
): Promise<ThreadSummary> {
  const res = await fetchImpl(`/api/threads/${encodeURIComponent(threadId)}/seen`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) {
    throw await errorFromResponse(res, "mark this chat as seen");
  }
  const body = (await res.json()) as { thread: ThreadSummary };
  return body.thread;
}

/**
 * Set or clear the thread's dismissal from the sidebar rail. Nothing else reads
 * it — the thread stays in All chats, search, and its project either way, which
 * is what separates this from archiving.
 */
export async function setThreadRecentDismissed(
  threadId: string,
  dismissed: boolean,
  fetchImpl: FetchLike = appFetch,
): Promise<ThreadSummary> {
  const res = await fetchImpl(`/api/threads/${encodeURIComponent(threadId)}/dismiss-recent`, {
    method: dismissed ? "POST" : "DELETE",
    credentials: "include",
  });
  if (!res.ok) {
    throw await errorFromResponse(res, dismissed ? "dismiss this chat" : "restore this chat");
  }
  const body = (await res.json()) as { thread: ThreadSummary };
  return body.thread;
}

export async function createThread(
  input?: CreateThreadInput,
  fetchImpl: FetchLike = appFetch,
): Promise<ThreadSummary> {
  const hasBody = input !== undefined && Object.keys(input).length > 0;
  const res = await fetchImpl("/api/threads", {
    method: "POST",
    credentials: "include",
    ...(hasBody
      ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }
      : {}),
  });
  if (!res.ok) {
    throw await errorFromResponse(res, "start a new chat");
  }
  const body = (await res.json()) as { thread: ThreadSummary };
  return body.thread;
}

export async function renameThread(
  threadId: string,
  title: string,
  fetchImpl: FetchLike = appFetch,
): Promise<ThreadSummary> {
  const res = await fetchImpl(`/api/threads/${encodeURIComponent(threadId)}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) {
    throw await errorFromResponse(res, "rename this chat");
  }
  const body = (await res.json()) as { thread: ThreadSummary };
  return body.thread;
}

export async function updateThreadReasoningEffort(
  threadId: string,
  reasoningEffort: ReasoningEffort,
  fetchImpl: FetchLike = appFetch,
): Promise<ThreadSummary> {
  const res = await fetchImpl(`/api/threads/${encodeURIComponent(threadId)}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reasoningEffort }),
  });
  if (!res.ok) {
    throw await errorFromResponse(res, "update thinking effort");
  }
  const body = (await res.json()) as { thread: ThreadSummary };
  return body.thread;
}

export async function moveThreadToProject(
  threadId: string,
  projectId: string | null,
  fetchImpl: FetchLike = appFetch,
): Promise<ThreadSummary> {
  const res = await fetchImpl(`/api/threads/${encodeURIComponent(threadId)}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId }),
  });
  if (!res.ok) {
    throw await errorFromResponse(res, "move this chat");
  }
  const body = (await res.json()) as { thread: ThreadSummary };
  return body.thread;
}

export async function switchThreadWorkbench(
  threadId: string,
  workbenchId: string | null,
  fetchImpl: FetchLike = appFetch,
): Promise<ThreadSummary> {
  const res = await fetchImpl(`/api/threads/${encodeURIComponent(threadId)}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workbenchId }),
  });
  if (!res.ok) {
    throw await errorFromResponse(res, "switch this chat's workbench");
  }
  const body = (await res.json()) as { thread: ThreadSummary };
  return body.thread;
}

/**
 * The compaction summaries of an archived thread.
 *
 * The archive stores the RAW transcript (archiving destroys the thread's Durable
 * Object, so the messages a summary hid must survive), and these are folded back in
 * at render time so an archived thread still reads the way the live one did. They
 * are served apart from the messages on purpose: a summary is a view, and storing
 * one as a message is what corrupted live threads.
 */
export async function fetchArchivedSummaries(
  threadId: string,
  fetchImpl: FetchLike = appFetch,
): Promise<ArchivedSummary[]> {
  const res = await fetchImpl(`/api/threads/${encodeURIComponent(threadId)}/summaries`, {
    credentials: "include",
  });
  if (!res.ok) throw await errorFromResponse(res, "load this chat's summaries");
  return (await res.json()) as ArchivedSummary[];
}

export async function sendThreadMessage(
  threadId: string,
  message: UIMessage,
  fetchImpl: FetchLike = appFetch,
): Promise<void> {
  const res = await fetchImpl(`/api/threads/${encodeURIComponent(threadId)}/messages`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw await errorFromResponse(res, "send your message");
}
