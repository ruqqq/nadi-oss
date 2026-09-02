import type { ThreadSummary } from "./threads-api";

/** What the read-only footer says: a fact, and where applicable the fix. */
export interface ThreadReadOnlyNotice {
  fact: string;
  /** `null` when there is nothing for the reader to do about it. */
  fix: string | null;
}

/**
 * The composer is already gone by the time this renders — this says WHY, so the
 * reader learns it here instead of by typing a message and watching the server
 * bounce it. The server gate is unchanged and remains the enforcement point.
 *
 * Deliberately not exhaustive over `readOnlyReason`: the field is optional on
 * the wire, so a payload from an older deploy arrives with none and falls
 * through to the wording this footer has always used.
 */
export function readOnlyNoticeForThread(thread: ThreadSummary): ThreadReadOnlyNotice {
  switch (thread.readOnlyReason) {
    case "agent_deleted":
      return { fact: "This chat's agent was deleted.", fix: "The chat stays here to read." };
    case "agent_disabled":
      return {
        fact: "This chat's agent is turned off.",
        fix: "Turn it back on in Settings → Agents to keep working here.",
      };
    default:
      return { fact: "Archived thread", fix: null };
  }
}

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
