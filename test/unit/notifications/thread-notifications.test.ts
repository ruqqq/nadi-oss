import { describe, expect, it } from "vitest";
import {
  buildThreadPushPayload,
  shouldSendThreadPush,
} from "../../../src/notifications/thread-notifications";

describe("thread notification service", () => {
  // A completion now names the thread that finished (see below); attention and
  // failure stay content-free.
  it("uses generic copy when there is nothing to name", () => {
    expect(buildThreadPushPayload({ type: "thread.attention_required", threadId: "t1" })).toEqual({
      title: "Action needed",
      body: "Open the thread to continue.",
      url: "/threads/t1",
    });
    expect(buildThreadPushPayload({ type: "thread.completed", threadId: "t1" })).toEqual({
      title: "Thread ready",
      body: "Nadi finished — tap to read the reply.",
      url: "/threads/t1",
    });
    expect(buildThreadPushPayload({ type: "thread.failed", threadId: "t1" })).toEqual({
      title: "Run failed",
      body: "Open the thread to check what happened.",
      url: "/threads/t1",
    });
  });

  it("thresholds completed push but not attention or failed", () => {
    expect(
      shouldSendThreadPush({
        type: "thread.completed",
        startedAt: 0,
        occurredAt: 1,
        hadWatchedWork: false,
        isAutomatonRun: false,
      }),
    ).toBe(false);
    expect(
      shouldSendThreadPush({
        type: "thread.completed",
        startedAt: 0,
        occurredAt: 12_000,
        hadWatchedWork: false,
        isAutomatonRun: false,
      }),
    ).toBe(true);
    expect(
      shouldSendThreadPush({
        type: "thread.attention_required",
        occurredAt: 1,
        isAutomatonRun: false,
      }),
    ).toBe(true);
    expect(
      shouldSendThreadPush({
        type: "thread.failed",
        startedAt: 0,
        occurredAt: 1,
        isAutomatonRun: false,
      }),
    ).toBe(true);
  });

  const completed = {
    type: "thread.completed",
    startedAt: 0,
    occurredAt: 60_000,
    hadWatchedWork: false,
  } as const;
  const failed = { type: "thread.failed", startedAt: 0, occurredAt: 1 } as const;
  const attention = { type: "thread.attention_required", occurredAt: 1 } as const;

  it("suppresses the success push for a failures-only automaton", () => {
    expect(
      shouldSendThreadPush({ ...completed, isAutomatonRun: true, notifyMode: "failures_only" }),
    ).toBe(false);
  });
  it("still pushes completion for an 'all' automaton", () => {
    expect(shouldSendThreadPush({ ...completed, isAutomatonRun: true, notifyMode: "all" })).toBe(
      true,
    );
  });
  it("always pushes failure and attention regardless of notifyMode", () => {
    expect(
      shouldSendThreadPush({ ...failed, isAutomatonRun: true, notifyMode: "failures_only" }),
    ).toBe(true);
    expect(
      shouldSendThreadPush({ ...attention, isAutomatonRun: true, notifyMode: "failures_only" }),
    ).toBe(true);
  });
});
