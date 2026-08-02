import type { ThreadActivityStatus, ThreadUnreadOutcome } from "../http/thread-serialize";

export const COMPLETION_PUSH_THRESHOLD_MS = 12_000;

export type ThreadLifecycleEvent =
  | { type: "thread.started"; startedAt: number }
  | { type: "thread.completed"; startedAt: number; completedAt: number }
  | { type: "thread.attention_required"; occurredAt: number }
  | { type: "thread.failed"; startedAt: number | null; failedAt: number };

export function applyThreadLifecycleState(input: {
  current: {
    activityStatus: ThreadActivityStatus;
    unreadOutcome: ThreadUnreadOutcome;
    attentionRequiredAt: number | null;
  };
  event: ThreadLifecycleEvent;
  isAway: boolean;
}): {
  activityStatus: ThreadActivityStatus;
  currentTurnStartedAt: number | null;
  attentionRequiredAt: number | null;
  unreadOutcome: ThreadUnreadOutcome;
  unreadOutcomeAt: number | null;
} {
  const { event, isAway } = input;

  if (event.type === "thread.started") {
    return {
      activityStatus: "running",
      currentTurnStartedAt: event.startedAt,
      attentionRequiredAt: null,
      unreadOutcome: null,
      unreadOutcomeAt: null,
    };
  }

  if (event.type === "thread.completed") {
    return {
      activityStatus: "idle",
      currentTurnStartedAt: null,
      attentionRequiredAt: null,
      unreadOutcome: isAway ? "completed" : null,
      unreadOutcomeAt: isAway ? event.completedAt : null,
    };
  }

  if (event.type === "thread.attention_required") {
    return {
      activityStatus: "attention_required",
      currentTurnStartedAt: null,
      attentionRequiredAt: event.occurredAt,
      unreadOutcome: null,
      unreadOutcomeAt: null,
    };
  }

  return {
    activityStatus: "failed",
    currentTurnStartedAt: null,
    attentionRequiredAt: null,
    unreadOutcome: isAway ? "failed" : null,
    unreadOutcomeAt: isAway ? event.failedAt : null,
  };
}

export function isCompletionPushEligible(input: {
  startedAt: number;
  completedAt: number;
  hadWatchedWork: boolean;
}): boolean {
  return (
    input.hadWatchedWork || input.completedAt - input.startedAt >= COMPLETION_PUSH_THRESHOLD_MS
  );
}
