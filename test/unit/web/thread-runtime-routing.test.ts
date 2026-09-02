import { describe, expect, it } from "vitest";
import {
  agentConnectionOptionsForThread,
  historyFetchTargetForThread,
  isReadOnlyThread,
  readOnlyNoticeForThread,
} from "../../../web/src/thread-runtime-routing";
import type { ThreadReadOnlyReason, ThreadSummary } from "../../../web/src/threads-api";

function thread(runtime: ThreadSummary["runtime"], threadId = "thr/a b"): ThreadSummary {
  return {
    threadId,
    kind: "regular",
    workspaceId: "workspace-1",
    agentId: "agent-1",
    provider: "openai-oauth",
    model: "gpt-5.5",
    modelInputModalities: ["text"],
    reasoningEffort: "medium",
    modelSupportsReasoning: true,
    runtime,
    title: "Thread",
    source: "manual",
    lastMessagePreview: "",
    archivedAt: null,
    readOnly: runtime === "legacy",
    status: "active",
    projectId: null,
    projectName: null,
    agentName: null,
    resourceProfile: "small",
    automatonId: null,
    automatonName: null,
    automatonNotifyMode: null,
    outcomeDismissedAt: null,
    recentDismissedAt: null,
    repositoryCount: 0,
    lastContextTokens: null,
    lastContextWindow: null,
    lastCompactAfterTokens: null,
    createdAt: 1,
    updatedAt: 2,
  };
}

describe("thread runtime routing", () => {
  it("treats legacy threads as read-only archive history", () => {
    expect(isReadOnlyThread(thread("legacy"))).toBe(true);
    expect(() => agentConnectionOptionsForThread(thread("legacy"))).toThrow(
      "thread_read_only",
    );
    // Reads from the D1 snapshot, exactly like an archived thread: the retired
    // runtime's DO class is gone, so there is no live route left to target.
    expect(historyFetchTargetForThread(thread("legacy"))).toEqual({
      kind: "archived",
      path: "/api/threads/thr%2Fa%20b/messages",
    });
  });

  it("routes Think threads through the Think-prefixed transport and history path", () => {
    expect(isReadOnlyThread(thread("think"))).toBe(false);
    expect(agentConnectionOptionsForThread(thread("think"))).toEqual({
      agent: "think-thread-agent",
      name: "thr/a b",
      basePath: "think-agents/think-thread-agent/thr%2Fa%20b",
    });
    expect(historyFetchTargetForThread(thread("think"))).toEqual({
      kind: "think",
      path: "/think-agents/think-thread-agent/thr%2Fa%20b/get-messages",
    });
  });

  it("routes an archived thread's history to the snapshot API", () => {
    expect(
      historyFetchTargetForThread({
        threadId: "thr/a b",
        runtime: "think",
        archivedAt: 123,
        projectId: null,
        projectName: null,
        repositoryCount: 0,
      } as ThreadSummary),
    ).toEqual({ kind: "archived", path: "/api/threads/thr%2Fa%20b/messages" });
  });

  it("sends a thread whose agent is gone down the read-only route", () => {
    // The routing gate is the server's `readOnly`, which now accounts for the
    // agent. Nothing about the agent is re-derived on the client.
    const gone: ThreadSummary = {
      ...thread("think"),
      readOnly: true,
      readOnlyReason: "agent_deleted",
    };
    expect(isReadOnlyThread(gone)).toBe(true);
    expect(() => agentConnectionOptionsForThread(gone)).toThrow("thread_read_only");
    // Not archived and not legacy, so its transcript still comes from the live
    // DO's snapshot endpoint — the agent being gone does not move the history.
    expect(historyFetchTargetForThread(gone)).toEqual({
      kind: "think",
      path: "/think-agents/think-thread-agent/thr%2Fa%20b/get-messages",
    });
  });
});

describe("readOnlyNoticeForThread", () => {
  it("explains a deleted agent", () => {
    expect(readOnlyNoticeForThread({ ...thread("think"), readOnlyReason: "agent_deleted" })).toEqual(
      { fact: "This chat's agent was deleted.", fix: "The chat stays here to read." },
    );
  });

  it("explains a disabled agent and names the fix", () => {
    expect(
      readOnlyNoticeForThread({ ...thread("think"), readOnlyReason: "agent_disabled" }),
    ).toEqual({
      fact: "This chat's agent is turned off.",
      fix: "Turn it back on in Settings → Agents to keep working here.",
    });
  });

  it.each([
    ["thread_archived" as const],
    ["legacy_runtime" as const],
  ])("keeps today's wording for %s", (readOnlyReason) => {
    expect(readOnlyNoticeForThread({ ...thread("think"), readOnlyReason })).toEqual({
      fact: "Archived thread",
      fix: null,
    });
  });

  it("falls back to today's wording when the field is absent", () => {
    // A payload serialized before `readOnlyReason` existed. The switch must not
    // be exhaustive, or such a tab renders nothing at all.
    expect(readOnlyNoticeForThread(thread("legacy"))).toEqual({
      fact: "Archived thread",
      fix: null,
    });
  });

  it("falls back for a reason this build does not know", () => {
    // The inverse case: a NEWER server sends a reason this bundle predates.
    expect(
      readOnlyNoticeForThread({
        ...thread("think"),
        readOnlyReason: "agent_evicted" as ThreadReadOnlyReason,
      }),
    ).toEqual({ fact: "Archived thread", fix: null });
  });
});
