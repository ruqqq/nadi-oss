import { describe, expect, it } from "vitest";
import {
  agentConnectionOptionsForThread,
  historyFetchTargetForThread,
  isReadOnlyThread,
} from "../../../web/src/thread-runtime-routing";
import type { ThreadSummary } from "../../../web/src/threads-api";

function thread(runtime: ThreadSummary["runtime"], threadId = "thr/a b"): ThreadSummary {
  return {
    threadId,
    kind: "regular",
    workspaceId: "workspace-1",
    agentId: "agent-1",
    provider: "openai-oauth",
    model: "gpt-5.5",
    modelInputModalities: ["text"],
    showReasoning: true,
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
    workbenchId: null,
    workbenchName: null,
    workbenchSwitchPending: false,
    resourceProfile: "small",
    automatonId: null,
    automatonName: null,
    automatonNotifyMode: null,
    outcomeDismissedAt: null,
    recentDismissedAt: null,
    repositorySnapshotCount: 0,
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
        repositorySnapshotCount: 0,
      } as ThreadSummary),
    ).toEqual({ kind: "archived", path: "/api/threads/thr%2Fa%20b/messages" });
  });
});
