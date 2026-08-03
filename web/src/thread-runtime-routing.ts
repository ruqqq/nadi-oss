import type { ThreadSummary } from "./threads-api";

/**
 * `runtime: "legacy"` is the retired ThreadAgentV2 runtime, whose Durable Object
 * class no longer exists in the Worker. Such a thread can be read but never
 * driven, so it is read-only for the same reason an archived one is.
 */
export function isReadOnlyThread(thread: ThreadSummary): boolean {
  return thread.readOnly || thread.runtime === "legacy" || thread.archivedAt !== null;
}

export function agentConnectionOptionsForThread(thread: ThreadSummary) {
  if (isReadOnlyThread(thread)) {
    throw new Error("thread_read_only");
  }

  return {
    agent: "think-thread-agent",
    name: thread.threadId,
    basePath: `think-agents/think-thread-agent/${encodeURIComponent(thread.threadId)}`,
  };
}

export function historyFetchTargetForThread(thread: ThreadSummary) {
  // Retired-runtime and archived threads both read from the D1 snapshot: neither
  // has a live DO to ask. Every legacy thread was archived when the runtime was
  // retired, so the runtime arm is only a backstop for a row that escaped that
  // sweep — without it such a row would target a route that no longer exists.
  if (thread.archivedAt !== null || thread.runtime === "legacy") {
    return {
      kind: "archived" as const,
      path: `/api/threads/${encodeURIComponent(thread.threadId)}/messages`,
    };
  }

  return {
    kind: "think" as const,
    path: `/think-agents/think-thread-agent/${encodeURIComponent(thread.threadId)}/get-messages`,
  };
}
