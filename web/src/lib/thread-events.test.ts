import { describe, expect, test } from "vitest";
import {
  applyUserEvent,
  mergeThread,
  mergeThreads,
  mergeThreadsExcluding,
  parseUserEvent,
  isAutomatonThreadHidden,
} from "./thread-events";
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
    reasoningEffort: "medium",
    modelSupportsReasoning: true,
    runtime: "legacy",
    title: "Title",
    source: "manual",
    lastMessagePreview: "",
    archivedAt: null,
    readOnly: true,
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
    updatedAt: 1,
    lastContextTokens: null,
    lastContextWindow: null,
    lastCompactAfterTokens: null,
    ...over,
  };
}

describe("mergeThread", () => {
  test("replaces an existing thread and sorts by updatedAt desc", () => {
    const a = thread({ threadId: "a", updatedAt: 1 });
    const b = thread({ threadId: "b", updatedAt: 2 });
    const aNewer = thread({ threadId: "a", updatedAt: 3 });
    expect(mergeThread([a, b], aNewer).map((t) => t.threadId)).toEqual(["a", "b"]);
  });
});

describe("mergeThreads", () => {
  test("merges a page in, keeping existing threads the page didn't touch", () => {
    const a = thread({ threadId: "a", updatedAt: 1 });
    const b = thread({ threadId: "b", updatedAt: 2 });
    const c = thread({ threadId: "c", updatedAt: 3 });
    const result = mergeThreads([a, b], [c]);
    expect(result.map((t) => t.threadId)).toEqual(["c", "b", "a"]);
  });

  test("a page overlapping the current array dedupes and takes the page's version", () => {
    const aOld = thread({ threadId: "a", updatedAt: 1, title: "old" });
    const b = thread({ threadId: "b", updatedAt: 2 });
    const aNew = thread({ threadId: "a", updatedAt: 5, title: "new" });
    const result = mergeThreads([aOld, b], [aNew]);
    expect(result.map((t) => t.threadId)).toEqual(["a", "b"]);
    expect(result.find((t) => t.threadId === "a")?.title).toBe("new");
  });

  test("merging an array into itself is a no-op on content (replace-vs-merge guard)", () => {
    const a = thread({ threadId: "a", updatedAt: 2 });
    const b = thread({ threadId: "b", updatedAt: 1 });
    const current = [a, b];
    const result = mergeThreads(current, current);
    expect(result.map((t) => t.threadId)).toEqual(["a", "b"]);
    expect(result).toHaveLength(2);
  });

  test("tied updatedAt stamps do not flip order when folded one at a time", () => {
    // mergeThread prepends-then-sorts, so folding a tied pair through
    // mergeThreads (as the offline self-merge does on every route change)
    // would reverse them without an id tie-break in the comparator.
    const a = thread({ threadId: "a", updatedAt: 2 });
    const b = thread({ threadId: "b", updatedAt: 2 });
    const current = [a, b];
    const result = mergeThreads(current, current);
    // Matches the server's (updatedAt desc, id desc) order for ties.
    expect(result.map((t) => t.threadId)).toEqual(["b", "a"]);
  });

  test("a short page never drops threads the shared array already had (replace would)", () => {
    // Regression guard: page one merging into the shared array must never shrink
    // it back down to page size — that would be a silent replace, not a merge.
    const many = Array.from({ length: 5 }, (_, i) =>
      thread({ threadId: `t${i}`, updatedAt: i }),
    );
    const onePageThread = thread({ threadId: "t0", updatedAt: 99 });
    const result = mergeThreads(many, [onePageThread]);
    expect(result.length).toBe(5);
  });
});

describe("mergeThreadsExcluding", () => {
  test("an excluded thread cannot be restored by a stale fetched page", () => {
    const stale = thread({ threadId: "archiving" });
    expect(mergeThreadsExcluding([], [stale], new Set(["archiving"]))).toEqual([]);
  });

  test("exclusion removes an existing row while preserving unrelated merged rows", () => {
    const removed = thread({ threadId: "removed", updatedAt: 3 });
    const kept = thread({ threadId: "kept", updatedAt: 2 });
    const added = thread({ threadId: "added", updatedAt: 1 });
    const result = mergeThreadsExcluding(
      [removed, kept],
      [removed, added],
      new Set(["removed"]),
    );
    expect(result.map((item) => item.threadId)).toEqual(["kept", "added"]);
  });
});

describe("parseUserEvent", () => {
  test("parses a thread.created event", () => {
    const raw = JSON.stringify({ type: "thread.created", thread: thread() });
    expect(parseUserEvent(raw)).toEqual({ type: "thread.created", thread: thread() });
  });
  test("parses a thread.deleted event", () => {
    const raw = JSON.stringify({ type: "thread.deleted", threadId: "t1", workspaceId: "w1" });
    expect(parseUserEvent(raw)).toEqual({
      type: "thread.deleted",
      threadId: "t1",
      workspaceId: "w1",
    });
  });
  test("parses a feedback report event", () => {
    expect(
      parseUserEvent(
        JSON.stringify({
          type: "feedback.report.created",
          reportId: "fbr_1",
          submittedAt: 1_800_000_000_000,
        }),
      ),
    ).toEqual({
      type: "feedback.report.created",
      reportId: "fbr_1",
      submittedAt: 1_800_000_000_000,
    });
  });
  test("parses enriched thread.updated summaries", () => {
    const parsed = parseUserEvent(
      JSON.stringify({
        type: "thread.updated",
        thread: thread({
          activityStatus: "attention_required",
          unreadOutcome: "failed",
        }),
      }),
    );
    expect(parsed).toMatchObject({
      type: "thread.updated",
      thread: { activityStatus: "attention_required", unreadOutcome: "failed" },
    });
  });
  test("returns null on invalid JSON", () => {
    expect(parseUserEvent("not json")).toBeNull();
  });
  test("returns null on an unknown type", () => {
    expect(parseUserEvent(JSON.stringify({ type: "nope" }))).toBeNull();
  });
  test("returns null when thread.deleted lacks a threadId", () => {
    expect(
      parseUserEvent(JSON.stringify({ type: "thread.deleted", workspaceId: "w1" })),
    ).toBeNull();
  });
  test("returns null when thread.created has a thread object without a threadId", () => {
    expect(parseUserEvent(JSON.stringify({ type: "thread.created", thread: {} }))).toBeNull();
  });
});

describe("applyUserEvent", () => {
  test("created/updated merges the thread", () => {
    const result = applyUserEvent([], {
      type: "thread.created",
      thread: thread({ threadId: "x" }),
    });
    expect(result.map((t) => t.threadId)).toEqual(["x"]);
  });
  test("updated preserves project fields from the latest summary", () => {
    const result = applyUserEvent(
      [thread({ threadId: "x", projectId: null, projectName: null, repositorySnapshotCount: 0 })],
      {
        type: "thread.updated",
        thread: thread({
          threadId: "x",
          projectId: "proj_1",
          projectName: "Project 1",
          repositorySnapshotCount: 3,
        }),
      },
    );
    expect(result[0]).toMatchObject({
      projectId: "proj_1",
      projectName: "Project 1",
      repositorySnapshotCount: 3,
    });
  });
  test("a repeated create is idempotent", () => {
    const t = thread({ threadId: "x" });
    const once = applyUserEvent([], { type: "thread.created", thread: t });
    const twice = applyUserEvent(once, { type: "thread.created", thread: t });
    expect(twice.map((t) => t.threadId)).toEqual(["x"]);
  });
  test("archived removes the thread from the active list", () => {
    const t = thread({ threadId: "x" });
    const archived = thread({ threadId: "x", archivedAt: 2, readOnly: true, status: "archived" });
    const result = applyUserEvent([t], { type: "thread.archived", thread: archived });
    expect(result).toEqual([]);
  });

  test("deleted removes the thread", () => {
    const t = thread({ threadId: "x" });
    const result = applyUserEvent([t], {
      type: "thread.deleted",
      threadId: "x",
      workspaceId: "w1",
    });
    expect(result).toEqual([]);
  });

  test("feedback report events do not mutate chat state", () => {
    const current = [thread({ threadId: "x" })];
    expect(
      applyUserEvent(current, {
        type: "feedback.report.created",
        reportId: "fbr_1",
        submittedAt: 1_800_000_000_000,
      }),
    ).toBe(current);
  });

  test("hides a quiet-success failures-only automaton thread", () => {
    const t = thread({
      source: "automaton",
      automatonNotifyMode: "failures_only",
      activityStatus: "idle",
      attentionRequiredAt: null,
      outcomeDismissedAt: null,
    });
    expect(isAutomatonThreadHidden(t)).toBe(true);
  });

  test("keeps a failed failures-only thread until dismissed", () => {
    const failed = thread({
      source: "automaton",
      automatonNotifyMode: "failures_only",
      activityStatus: "failed",
      attentionRequiredAt: null,
      outcomeDismissedAt: null,
    });
    expect(isAutomatonThreadHidden(failed)).toBe(false);
    expect(isAutomatonThreadHidden({ ...failed, outcomeDismissedAt: 5 })).toBe(true);
  });

  test("live update for a hidden thread removes it from the list", () => {
    const hidden = thread({
      threadId: "t1",
      source: "automaton",
      automatonNotifyMode: "failures_only",
      activityStatus: "idle",
      attentionRequiredAt: null,
      outcomeDismissedAt: null,
    });
    const result = applyUserEvent([hidden], { type: "thread.updated", thread: hidden });
    expect(result.some((t) => t.threadId === "t1")).toBe(false);
  });

  test("'all' mode automaton threads are never hidden", () => {
    const t = thread({ source: "automaton", automatonNotifyMode: "all", activityStatus: "idle" });
    expect(isAutomatonThreadHidden(t)).toBe(false);
  });
});
