import type { FileUIPart } from "ai";

/**
 * A new thread's first message while it is still being delivered.
 *
 * Every field of this type is subordinate to `threadId`. The original bug was a
 * pending message with NO thread binding, delivered by whichever <ThreadChat>
 * happened to be mounted — so it landed in the wrong thread. Everything here is
 * keyed by threadId precisely so that cannot come back: a status change, a
 * settle, or a render against a different thread is a no-op, not a coincidence.
 *
 * `messageId` is the id the delivered message is POSTed under. It exists
 * because "the thread has messages" is NOT the same as "this message arrived":
 * a socket that connects mid-turn resumes the assistant's stream without ever
 * receiving the user message that started it, so an assistant-only transcript
 * must neither hide the bubble nor settle the pending state.
 */
export type PendingFirstMessage = {
  threadId: string;
  messageId: string;
  text: string;
  files: FileUIPart[];
  status: "sending" | "sent" | "failed";
};

export type PendingFirstMessageStatus = PendingFirstMessage["status"];

/**
 * The pending message to render in `threadId`'s conversation, or null.
 *
 * The bubble is optimistic: it stands in for the delivered message until that
 * exact message is in the transcript — which is why it can neither
 * double-render alongside the real one nor vanish while the text is still
 * missing (the mid-turn-connect bug).
 */
export function pendingForThread(
  pending: PendingFirstMessage | null,
  threadId: string,
  messageIds: ReadonlySet<string>,
): PendingFirstMessage | null {
  if (pending === null || pending.threadId !== threadId) return null;
  return messageIds.has(pending.messageId) ? null : pending;
}

/** The delivered message itself has arrived in its own thread's transcript. */
export function shouldSettleFirstMessage(
  pending: PendingFirstMessage | null,
  threadId: string,
  messageIds: ReadonlySet<string>,
): boolean {
  if (pending === null || pending.threadId !== threadId) return false;
  return messageIds.has(pending.messageId);
}

/**
 * Delivery was confirmed (the POST resolved) but the message never reached
 * this client — the apply-time broadcast was missed because the socket
 * connected mid-turn. The caller should refetch the authoritative history.
 */
export function needsFirstMessageResync(
  pending: PendingFirstMessage | null,
  threadId: string,
  messageIds: ReadonlySet<string>,
): boolean {
  if (pending === null || pending.threadId !== threadId) return false;
  return pending.status === "sent" && !messageIds.has(pending.messageId);
}

/** Apply a delivery outcome — but only to the thread it belongs to. */
export function withStatus(
  pending: PendingFirstMessage | null,
  threadId: string,
  status: PendingFirstMessageStatus,
): PendingFirstMessage | null {
  if (pending === null || pending.threadId !== threadId) return pending;
  return { ...pending, status };
}

/** Drop the pending message once its thread has the real one. */
export function settled(
  pending: PendingFirstMessage | null,
  threadId: string,
): PendingFirstMessage | null {
  if (pending === null || pending.threadId !== threadId) return pending;
  return null;
}

/** A failed message can be retried; one already in flight cannot be double-sent. */
export function isRetryable(pending: PendingFirstMessage | null): boolean {
  return pending !== null && pending.status !== "sending";
}
