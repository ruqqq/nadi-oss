import { describe, expect, it } from "vitest";
import {
  isRetryable,
  needsFirstMessageResync,
  pendingForThread,
  settled,
  shouldSettleFirstMessage,
  withStatus,
  type PendingFirstMessage,
} from "./pending-first-message";

const pending: PendingFirstMessage = {
  threadId: "thr_new",
  messageId: "msg_first",
  text: "hello",
  files: [],
  status: "sending",
};

const none: ReadonlySet<string> = new Set();
const delivered: ReadonlySet<string> = new Set(["msg_first"]);
// A socket that connects mid-turn resumes the assistant's stream but never
// receives the user message that started the turn — the transcript is
// non-empty yet the first message is missing.
const assistantOnly: ReadonlySet<string> = new Set(["msg_assistant"]);

describe("pendingForThread", () => {
  it("renders in the thread the message was written for", () => {
    expect(pendingForThread(pending, "thr_new", none)).toBe(pending);
  });

  // THE original bug. The user submits from the new-thread composer, then
  // switches to another thread while the send is in flight. That thread must
  // show nothing.
  it("renders NOTHING in a thread the user switched to", () => {
    expect(pendingForThread(pending, "thr_other", none)).toBeNull();
  });

  it("yields to the real message once IT is in the thread", () => {
    expect(pendingForThread(pending, "thr_new", delivered)).toBeNull();
  });

  // The mid-turn-connect bug: an assistant message streaming in must not make
  // the bubble yield — the user's own message hasn't arrived yet, and hiding
  // the bubble then makes the sent text vanish from the conversation entirely.
  it("keeps rendering while the thread has other messages but not this one", () => {
    expect(pendingForThread(pending, "thr_new", assistantOnly)).toBe(pending);
  });

  it("renders nothing when there is no pending message", () => {
    expect(pendingForThread(null, "thr_new", none)).toBeNull();
  });
});

describe("shouldSettleFirstMessage", () => {
  it("settles once the delivered message itself is in the transcript", () => {
    expect(shouldSettleFirstMessage(pending, "thr_new", delivered)).toBe(true);
  });

  it("does not settle on unrelated messages (mid-turn assistant stream)", () => {
    expect(shouldSettleFirstMessage(pending, "thr_new", assistantOnly)).toBe(false);
  });

  // A ThreadChat mounted for a DIFFERENT thread must never settle a message
  // pending for the new one — its transcript says nothing about delivery.
  it("does not settle from another thread's transcript", () => {
    expect(shouldSettleFirstMessage(pending, "thr_other", delivered)).toBe(false);
  });

  it("has nothing to settle when nothing is pending", () => {
    expect(shouldSettleFirstMessage(null, "thr_new", delivered)).toBe(false);
  });
});

describe("needsFirstMessageResync", () => {
  it("wants a resync once delivery is confirmed but the message never arrived", () => {
    expect(needsFirstMessageResync({ ...pending, status: "sent" }, "thr_new", none)).toBe(true);
    expect(needsFirstMessageResync({ ...pending, status: "sent" }, "thr_new", assistantOnly)).toBe(
      true,
    );
  });

  it("does not resync while the POST is still in flight or after a failure", () => {
    expect(needsFirstMessageResync(pending, "thr_new", none)).toBe(false);
    expect(needsFirstMessageResync({ ...pending, status: "failed" }, "thr_new", none)).toBe(false);
  });

  it("stops once the message has arrived", () => {
    expect(needsFirstMessageResync({ ...pending, status: "sent" }, "thr_new", delivered)).toBe(
      false,
    );
  });

  it("only resyncs the thread the message belongs to", () => {
    expect(needsFirstMessageResync({ ...pending, status: "sent" }, "thr_other", none)).toBe(false);
  });

  it("has nothing to resync when nothing is pending", () => {
    expect(needsFirstMessageResync(null, "thr_new", none)).toBe(false);
  });
});

describe("withStatus", () => {
  it("applies the outcome to the thread it belongs to", () => {
    expect(withStatus(pending, "thr_new", "failed")).toEqual({ ...pending, status: "failed" });
  });

  // A late delivery result must not stamp its outcome onto a pending message
  // that now belongs to a different (newer) thread.
  it("ignores an outcome aimed at a different thread", () => {
    const untouched = withStatus(pending, "thr_other", "failed");
    expect(untouched).toBe(pending);
    expect(untouched?.status).toBe("sending");
  });

  it("is a no-op when nothing is pending", () => {
    expect(withStatus(null, "thr_new", "sent")).toBeNull();
  });
});

describe("settled", () => {
  it("clears the pending message once its own thread has the real one", () => {
    expect(settled(pending, "thr_new")).toBeNull();
  });

  // Another thread loading its history must not silently discard a message that
  // is still in flight for a different thread — that would lose it with no trace.
  it("does not clear a message pending for a different thread", () => {
    expect(settled(pending, "thr_other")).toBe(pending);
  });
});

describe("isRetryable", () => {
  it("offers retry once delivery has failed", () => {
    expect(isRetryable({ ...pending, status: "failed" })).toBe(true);
  });

  // Guards the double-send: a message still in flight must not be resent.
  it("refuses to retry a message that is still in flight", () => {
    expect(isRetryable(pending)).toBe(false);
  });

  it("has nothing to retry when nothing is pending", () => {
    expect(isRetryable(null)).toBe(false);
  });
});
