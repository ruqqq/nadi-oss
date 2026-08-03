import { describe, expect, test } from "vitest";
import { isThreadDismissedFromRail, visibleRailThreads } from "./thread-dismissal";
import type { ThreadSummary } from "../threads-api";

function thread(over: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    threadId: "t1",
    kind: "regular",
    workspaceId: "w1",
    agentId: "a1",
    provider: "openai-oauth",
    model: "gpt-5.5",
    modelInputModalities: ["text"],
    showReasoning: true,
    reasoningEffort: "medium",
    modelSupportsReasoning: true,
    runtime: "think",
    title: "Title",
    source: "manual",
    lastMessagePreview: "",
    archivedAt: null,
    readOnly: false,
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
    createdAt: 1,
    updatedAt: 100,
    lastContextTokens: null,
    lastContextWindow: null,
    lastCompactAfterTokens: null,
    ...over,
  };
}

describe("isThreadDismissedFromRail", () => {
  test("a thread that was never dismissed is not dismissed", () => {
    expect(isThreadDismissedFromRail(thread({ recentDismissedAt: null }))).toBe(false);
  });

  test("a stamp newer than the thread's activity hides it", () => {
    expect(isThreadDismissedFromRail(thread({ updatedAt: 100, recentDismissedAt: 150 }))).toBe(
      true,
    );
  });

  test("activity after the dismissal brings the thread back", () => {
    expect(isThreadDismissedFromRail(thread({ updatedAt: 200, recentDismissedAt: 150 }))).toBe(
      false,
    );
  });

  test("an equal stamp still counts as dismissed", () => {
    // Same-millisecond writes are ordinary. Treating the tie as "not dismissed"
    // would make the action look like it did nothing.
    expect(isThreadDismissedFromRail(thread({ updatedAt: 100, recentDismissedAt: 100 }))).toBe(
      true,
    );
  });
});

describe("visibleRailThreads", () => {
  const plain = thread({ threadId: "plain", updatedAt: 100 });
  const dismissed = thread({ threadId: "dismissed", updatedAt: 100, recentDismissedAt: 150 });

  test("hides a dismissed thread from the plain list", () => {
    const visible = visibleRailThreads([plain, dismissed], {
      searching: false,
      activeThreadId: null,
    });
    expect(visible.map((t) => t.threadId)).toEqual(["plain"]);
  });

  test("shows a dismissed thread while searching", () => {
    const visible = visibleRailThreads([plain, dismissed], {
      searching: true,
      activeThreadId: null,
    });
    expect(visible.map((t) => t.threadId)).toEqual(["plain", "dismissed"]);
  });

  test("shows a dismissed thread while it is the active one", () => {
    const visible = visibleRailThreads([plain, dismissed], {
      searching: false,
      activeThreadId: "dismissed",
    });
    expect(visible.map((t) => t.threadId)).toEqual(["plain", "dismissed"]);
  });

  test("hides it again once a different thread is active", () => {
    const visible = visibleRailThreads([plain, dismissed], {
      searching: false,
      activeThreadId: "plain",
    });
    expect(visible.map((t) => t.threadId)).toEqual(["plain"]);
  });
});
