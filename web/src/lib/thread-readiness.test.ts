import { describe, expect, test } from "vitest";
import { computeThreadReadiness } from "./thread-readiness";

/** Connected, idle, complete transcript — the boring case. Spread and override. */
const base = {
  socketConnected: true,
  everConnected: true,
  historyReloading: false,
  pendingReplyExpired: false,
  offline: false,
  streamActive: false,
  awaitingReply: false,
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
      computeThreadReadiness({ ...base, socketConnected: false }),
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
      pendingReplyExpired: true,
      offline: true,
    });
    expect(readiness.reason).toBe("offline");
  });
});

/**
 * The transcript renders as soon as history resolves — the socket no longer
 * gates it (the composer's own sendBlocked gate is what keeps that honest). This
 * predicate only decides whether we forewarn that a reply is inbound, and it
 * holds until the reply itself arrives rather than until the socket opens.
 */
describe("showPendingReply", () => {
  /** Still on the first connect, with history that stops mid-turn. */
  const connecting = {
    ...base,
    socketConnected: false,
    everConnected: false,
    awaitingReply: true,
  };

  test("history ends mid-turn while connecting: a reply really is inbound", () => {
    expect(computeThreadReadiness(connecting).showPendingReply).toBe(true);
  });

  test("transcript ends on an assistant reply: nothing is coming", () => {
    expect(computeThreadReadiness({ ...connecting, awaitingReply: false }).showPendingReply).toBe(
      false,
    );
  });

  test("offline: no socket is coming, so no reply is coming", () => {
    expect(computeThreadReadiness({ ...connecting, offline: true }).showPendingReply).toBe(false);
  });

  // The valve. Nothing else in the predicate goes false on its own, so without
  // it a thread whose turn died mid-flight promises a reply forever.
  test("window expired: stop promising", () => {
    expect(
      computeThreadReadiness({ ...connecting, pendingReplyExpired: true }).showPendingReply,
    ).toBe(false);
  });

  // THE REGRESSION GUARD. This used to be false: the predicate released on
  // `everConnected`, but the socket opens a few hundred ms before the SDK's
  // chunk replay starts. That window had no bubble and no dots — the
  // placeholder went away before its replacement arrived. Holding through the
  // open is the whole fix.
  test("socket open but nothing streaming yet: keep promising", () => {
    expect(
      computeThreadReadiness({ ...connecting, socketConnected: true, everConnected: true })
        .showPendingReply,
    ).toBe(true);
  });

  // ...and the handoff: once the stream is live it owns the indicator, so both
  // clauses must never be true at once (they'd render two sets of dots).
  test("stream took over: isStreaming drives the dots from here", () => {
    expect(
      computeThreadReadiness({
        ...connecting,
        socketConnected: true,
        everConnected: true,
        streamActive: true,
      }).showPendingReply,
    ).toBe(false);
  });
});
