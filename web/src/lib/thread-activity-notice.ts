import type { ThreadSummary } from "../threads-api";

/**
 * Does this `thread.updated` deserve an in-app notice, and of what kind?
 *
 * The counterpart to server-side push suppression: the server declines to send
 * an OS notification to someone already in the app (see
 * src/notifications/thread-notifications.ts), so this is the channel that tells
 * them instead. Same socket the rail already listens to — no new transport.
 *
 * Three rules, and all three are about NOT firing:
 *
 *  - Only on a transition. `thread.updated` also fires for renames, project
 *    moves and live-status flips; re-announcing an outcome the user already saw
 *    on every one of those is how a notice becomes something people learn to
 *    ignore.
 *  - Never for the thread on screen. You can watch that one happen.
 *  - Never without a previous state. A thread arriving for the first time —
 *    boot, a fresh automaton run — has nothing to have transitioned FROM, and
 *    treating "new to me" as "just happened" would fire a burst on every
 *    reconnect.
 */
export type ThreadNoticeKind = "attention" | "failed" | "completed";

export interface ThreadActivityNotice {
  threadId: string;
  title: string;
  kind: ThreadNoticeKind;
  /**
   * The excerpt the push would have shown, when the broadcast carried one.
   * Always shown in-app when present — unlike push, this is not gated on
   * `pushPreviewEnabled`, which exists because a push preview lands on a lock
   * screen. Absent for a turn that produced no prose, which falls back to the
   * generic copy.
   */
  preview?: string;
}

export type ThreadNoticeState = Pick<ThreadSummary, "attentionRequiredAt" | "unreadOutcome">;

export const EMPTY_NOTICE_STATE: ThreadNoticeState = {
  attentionRequiredAt: null,
  unreadOutcome: null,
};

/** The two fields a notice turns on, or undefined for a thread we don't know. */
export function threadNoticeState(
  thread: ThreadSummary | undefined,
): ThreadNoticeState | undefined {
  if (!thread) return undefined;
  return {
    attentionRequiredAt: thread.attentionRequiredAt ?? null,
    unreadOutcome: thread.unreadOutcome ?? null,
  };
}

export function threadActivityNotice(input: {
  previous: ThreadNoticeState | undefined;
  next: ThreadSummary;
  activeThreadId: string | null;
  preview?: string | undefined;
}): ThreadActivityNotice | null {
  const { previous, next, activeThreadId } = input;
  if (!previous) return null;
  if (next.threadId === activeThreadId) return null;

  const preview = input.preview?.trim();
  const identity = {
    threadId: next.threadId,
    title: next.title,
    ...(preview ? { preview } : {}),
  };

  // Attention outranks an outcome: a blocked agent is waiting on the user, and
  // a turn that ends in a gate can carry both fields in the same update.
  if (next.attentionRequiredAt != null && previous.attentionRequiredAt == null) {
    return { ...identity, kind: "attention" };
  }

  const outcome = next.unreadOutcome ?? null;
  if (outcome && outcome !== (previous.unreadOutcome ?? null)) {
    return { ...identity, kind: outcome };
  }

  return null;
}
