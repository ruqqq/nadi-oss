import { describe, expect, test } from "vitest";
import { computeThreadReadiness } from "./thread-readiness";

/** Connected, idle, complete transcript — the boring case. Spread and override. */
const base = {
  socketConnected: true,
  everConnected: true,
  historyReloading: false,
  connectTimedOut: false,
  offline: false,
  messageCount: 2,
  conversationComplete: true,
};

describe("computeThreadReadiness", () => {
  test("fresh mount, socket not yet open: send blocked, connecting", () => {
    expect(
      computeThreadReadiness({
        ...base,
        socketConnected: false,
        everConnected: false,
      }),
    ).toEqual({ showPendingReply: false, sendBlocked: true, reason: "connecting" });
  });

  test("connected and idle: no block, no pending reply", () => {
    expect(computeThreadReadiness(base)).toEqual({
      showPendingReply: false,
      sendBlocked: false,
      reason: null,
    });
  });

  test("socket dropped after first connect: send blocked, reconnecting", () => {
    expect(
      computeThreadReadiness({ ...base, socketConnected: false, conversationComplete: true }),
    ).toEqual({ showPendingReply: false, sendBlocked: true, reason: "reconnecting" });
  });

  test("history reloading while connected: send blocked, reloading", () => {
    expect(computeThreadReadiness({ ...base, historyReloading: true })).toEqual({
      showPendingReply: false,
      sendBlocked: true,
      reason: "reloading",
    });
  });

  test("socket-down reason wins over reloading", () => {
    expect(
      computeThreadReadiness({ ...base, socketConnected: false, historyReloading: true }),
    ).toEqual({ showPendingReply: false, sendBlocked: true, reason: "reconnecting" });
  });

  test("offline blocks sending and says so", () => {
    // socketConnected/everConnected true and no reload/timeout: without offline
    // wired into sendBlocked this would be unblocked, so this fails if offline
    // is dropped from the expression.
    const readiness = computeThreadReadiness({ ...base, offline: true });
    expect(readiness.sendBlocked).toBe(true);
    expect(readiness.reason).toBe("offline");
  });

  test("offline outranks a reconnecting socket in the hint", () => {
    const readiness = computeThreadReadiness({
      ...base,
      socketConnected: false,
      connectTimedOut: true,
      offline: true,
    });
    expect(readiness.reason).toBe("offline");
  });
});

/**
 * The transcript renders as soon as history resolves — the socket no longer
 * gates it (the composer's own sendBlocked gate is what keeps that honest). The
 * only thing the first connect still drives is whether we forewarn that a reply
 * is inbound.
 */
describe("showPendingReply", () => {
  /** Still on the first connect, with history that stops mid-turn. */
  const connecting = {
    ...base,
    socketConnected: false,
    everConnected: false,
    conversationComplete: false,
  };

  test("history ends mid-turn while connecting: a reply really is inbound", () => {
    expect(computeThreadReadiness(connecting).showPendingReply).toBe(true);
  });

  test("completed transcript: nothing is coming, so promise nothing", () => {
    expect(
      computeThreadReadiness({ ...connecting, conversationComplete: true }).showPendingReply,
    ).toBe(false);
  });

  // isConversationComplete([]) is FALSE, so an empty thread reads as "mid-turn"
  // unless messageCount guards it. A brand-new chat must not promise a reply.
  test("empty thread: never, even though it reads as incomplete", () => {
    expect(computeThreadReadiness({ ...connecting, messageCount: 0 }).showPendingReply).toBe(false);
  });

  test("offline: no socket is coming, so no reply is coming", () => {
    expect(computeThreadReadiness({ ...connecting, offline: true }).showPendingReply).toBe(false);
  });

  // The 4s valve that used to release the full skeleton now releases this, so a
  // socket that never opens can't leave the dots twitching forever.
  test("connect timed out: stop promising", () => {
    expect(computeThreadReadiness({ ...connecting, connectTimedOut: true }).showPendingReply).toBe(
      false,
    );
  });

  // Once the socket is up, isStreaming drives the indicator — this predicate is
  // only about the gap before the first connect.
  test("already connected once: isStreaming takes over, not this", () => {
    expect(computeThreadReadiness({ ...connecting, everConnected: true }).showPendingReply).toBe(
      false,
    );
  });
});
