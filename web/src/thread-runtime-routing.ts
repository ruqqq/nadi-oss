import type { ThreadSummary } from "./threads-api";

export function isReadOnlyThread(thread: ThreadSummary): boolean {
  return thread.readOnly || thread.runtime === "legacy" || thread.archivedAt !== null;
}

export function agentConnectionOptionsForThread(thread: ThreadSummary) {
  if (isReadOnlyThread(thread)) {
    throw new Error("thread_read_only");
  }

  if (thread.runtime === "think") {
    return {
      agent: "think-thread-agent",
      name: thread.threadId,
      basePath: `think-agents/think-thread-agent/${encodeURIComponent(thread.threadId)}`,
    };
  }

  return {
    agent: "thread-agent",
    name: thread.threadId,
  };
}

export function historyFetchTargetForThread(thread: ThreadSummary) {
  if (thread.archivedAt !== null) {
    return {
      kind: "archived" as const,
      path: `/api/threads/${encodeURIComponent(thread.threadId)}/messages`,
    };
  }
  if (thread.runtime === "think") {
    return {
      kind: "think" as const,
      path: `/think-agents/think-thread-agent/${encodeURIComponent(thread.threadId)}/get-messages`,
    };
  }

  return {
    kind: "legacy" as const,
    path: `/agents/thread-agent/${encodeURIComponent(thread.threadId)}/get-messages`,
  };
}
