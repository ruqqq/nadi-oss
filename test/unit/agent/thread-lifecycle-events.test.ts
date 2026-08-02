import { describe, expect, it } from "vitest";
import {
  applyThreadLifecycleState,
  isCompletionPushEligible,
} from "../../../src/agent/thread-lifecycle-events";

describe("thread lifecycle state", () => {
  it("marks a started turn as running", () => {
    expect(
      applyThreadLifecycleState({
        current: { activityStatus: "idle", unreadOutcome: null, attentionRequiredAt: null },
        event: { type: "thread.started", startedAt: 100 },
        isAway: false,
      }),
    ).toEqual({
      activityStatus: "running",
      currentTurnStartedAt: 100,
      attentionRequiredAt: null,
      unreadOutcome: null,
      unreadOutcomeAt: null,
    });
  });

  it("sets completed unread only while away", () => {
    expect(
      applyThreadLifecycleState({
        current: { activityStatus: "running", unreadOutcome: null, attentionRequiredAt: null },
        event: { type: "thread.completed", startedAt: 100, completedAt: 200 },
        isAway: true,
      }),
    ).toMatchObject({ activityStatus: "idle", unreadOutcome: "completed", unreadOutcomeAt: 200 });
  });

  it("keeps attention required until an explicit non-attention transition", () => {
    expect(
      applyThreadLifecycleState({
        current: { activityStatus: "running", unreadOutcome: null, attentionRequiredAt: null },
        event: { type: "thread.attention_required", occurredAt: 300 },
        isAway: true,
      }),
    ).toMatchObject({ activityStatus: "attention_required", attentionRequiredAt: 300 });
  });

  it("thresholds completed push at twelve seconds", () => {
    expect(
      isCompletionPushEligible({ startedAt: 0, completedAt: 11_999, hadWatchedWork: false }),
    ).toBe(false);
    expect(
      isCompletionPushEligible({ startedAt: 0, completedAt: 12_000, hadWatchedWork: false }),
    ).toBe(true);
    expect(isCompletionPushEligible({ startedAt: 0, completedAt: 1, hadWatchedWork: true })).toBe(
      true,
    );
  });
});
