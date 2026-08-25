import { describe, expect, test } from "vitest";
import {
  WS_CLOSED,
  WS_CLOSING,
  WS_CONNECTING,
  WS_OPEN,
  resolveHiddenMs,
  shouldNudgeReconnect,
  shouldRecoverOnResume,
  watchdogTick,
} from "./connection-recovery";

describe("resolveHiddenMs", () => {
  test("returns 0 when the page was never recorded as hidden (spurious resume)", () => {
    expect(resolveHiddenMs(null, 1_000, false)).toBe(0);
  });

  test("treats a bfcache restore with no recorded hide as definitely stale", () => {
    // iOS Safari can freeze via pagehide without firing visibilitychange→hidden,
    // so a bfcache pageshow with no hiddenAt must still count as a long absence.
    expect(resolveHiddenMs(null, 1_000, true)).toBe(Number.POSITIVE_INFINITY);
  });

  test("computes elapsed time since the tab was hidden", () => {
    expect(resolveHiddenMs(1_000, 21_000, false)).toBe(20_000);
  });

  test("clamps a backwards clock to 0", () => {
    expect(resolveHiddenMs(5_000, 1_000, false)).toBe(0);
  });
});

describe("shouldRecoverOnResume", () => {
  const MIN = 1_000;

  test("skips a sub-threshold flicker", () => {
    expect(shouldRecoverOnResume(500, MIN)).toBe(false);
  });

  test("skips a spurious zero-duration resume (initial load)", () => {
    expect(shouldRecoverOnResume(0, MIN)).toBe(false);
  });

  test("recovers at exactly the threshold", () => {
    expect(shouldRecoverOnResume(MIN, MIN)).toBe(true);
  });

  test("recovers after a real background", () => {
    expect(shouldRecoverOnResume(20_000, MIN)).toBe(true);
  });

  test("always recovers on an Infinity signal (bfcache / network-online)", () => {
    expect(shouldRecoverOnResume(Number.POSITIVE_INFINITY, MIN)).toBe(true);
  });
});

describe("shouldNudgeReconnect", () => {
  test("nudges a CLOSED socket when the tab is visible and online", () => {
    expect(shouldNudgeReconnect(WS_CLOSED, true, true)).toBe(true);
  });

  test("nudges a CLOSING socket when the tab is visible and online", () => {
    expect(shouldNudgeReconnect(WS_CLOSING, true, true)).toBe(true);
  });

  test("does not nudge while the tab is hidden", () => {
    expect(shouldNudgeReconnect(WS_CLOSED, false, true)).toBe(false);
  });

  test("does not nudge while offline", () => {
    expect(shouldNudgeReconnect(WS_CLOSED, true, false)).toBe(false);
  });

  test("does not nudge an OPEN socket", () => {
    expect(shouldNudgeReconnect(WS_OPEN, true, true)).toBe(false);
  });

  test("does not nudge a CONNECTING socket (reconnect already in flight)", () => {
    expect(shouldNudgeReconnect(WS_CONNECTING, true, true)).toBe(false);
  });
});

describe("watchdogTick", () => {
  test("nudges a dead socket and remembers it did", () => {
    expect(watchdogTick(false, WS_CLOSED, true, true)).toEqual({
      nudge: true,
      resync: false,
      nudged: true,
    });
  });

  test("does not resync while the socket is still down", () => {
    // The watchdog runs every few seconds; resyncing on each tick would hammer
    // /get-messages for as long as the socket stays dead.
    expect(watchdogTick(true, WS_CLOSED, true, true).resync).toBe(false);
  });

  test("does not resync while the reconnect is still in flight", () => {
    expect(watchdogTick(true, WS_CONNECTING, true, true)).toEqual({
      nudge: false,
      resync: false,
      nudged: true,
    });
  });

  test("resyncs once the nudged socket is OPEN again", () => {
    expect(watchdogTick(true, WS_OPEN, true, true)).toEqual({
      nudge: false,
      resync: true,
      nudged: false,
    });
  });

  test("resyncs only once per revival", () => {
    const first = watchdogTick(true, WS_OPEN, true, true);
    expect(first.resync).toBe(true);
    expect(watchdogTick(first.nudged, WS_OPEN, true, true).resync).toBe(false);
  });

  test("a socket that was never nudged does not resync", () => {
    expect(watchdogTick(false, WS_OPEN, true, true)).toEqual({
      nudge: false,
      resync: false,
      nudged: false,
    });
  });

  test("holds the pending resync across a hidden tab", () => {
    // Hidden means no nudge, but the flag must survive so the refetch still
    // happens when the socket comes back.
    expect(watchdogTick(true, WS_CLOSED, false, true)).toEqual({
      nudge: false,
      resync: false,
      nudged: true,
    });
  });

  test("holds the pending resync while offline", () => {
    expect(watchdogTick(true, WS_CLOSED, true, false).nudged).toBe(true);
  });
});
