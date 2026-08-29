/**
 * Pure decision logic for self-healing the chat across tab background/resume.
 * The DOM/React glue lives in use-connection-recovery.ts; keeping the decisions
 * pure makes them unit-testable in the node test env.
 *
 * Why this exists: a plain WebSocket reconnect does NOT resync the conversation.
 * The Agents SDK server only sends message history over HTTP `/get-messages`
 * (fetched once on mount) or broadcasts a finished turn to *live* sockets — a
 * backgrounded/frozen tab misses the broadcast and stays stale. So on resume we
 * must both refetch messages and reconnect the socket; this module decides when.
 */

// Standard WebSocket.readyState values.
export const WS_CONNECTING = 0;
export const WS_OPEN = 1;
export const WS_CLOSING = 2;
export const WS_CLOSED = 3;

/**
 * How long the tab was hidden, given the recorded hide time and whether this is
 * a bfcache restore. `hiddenAt === null` means we never saw a hide event: for a
 * normal resume that's a spurious/initial signal (0), but iOS Safari can freeze
 * via `pagehide` without a `visibilitychange`, so a bfcache restore with no
 * recorded hide is treated as a long absence (Infinity → always recover).
 */
export function resolveHiddenMs(
  hiddenAt: number | null,
  now: number,
  bfcacheRestore: boolean,
): number {
  if (hiddenAt === null) return bfcacheRestore ? Number.POSITIVE_INFINITY : 0;
  return Math.max(0, now - hiddenAt);
}

/**
 * Whether a resume warrants recovery (refetch messages + reconnect). Sub-second
 * visibility flickers and the initial-load signal (hiddenMs 0) are skipped;
 * genuine backgrounds and Infinity signals (bfcache / network-online) recover.
 */
export function shouldRecoverOnResume(hiddenMs: number, minHiddenMs: number): boolean {
  return hiddenMs >= minHiddenMs;
}

/**
 * Foreground watchdog: while the tab is visible and the network is up, a
 * CLOSED/CLOSING socket should be nudged back to life. This catches a socket
 * that dies while the tab stays in the foreground (no resume event fires) and
 * recovers faster than partysocket's own backoff. No-op while hidden/offline or
 * already OPEN/CONNECTING.
 */
export function shouldNudgeReconnect(
  readyState: number,
  isVisible: boolean,
  isOnline: boolean,
): boolean {
  if (!isVisible || !isOnline) return false;
  return readyState === WS_CLOSED || readyState === WS_CLOSING;
}

/**
 * One foreground-watchdog tick, as a state machine over the `nudged` flag.
 *
 * Nudging a dead socket back is only half a recovery. The reconnected socket
 * gets NOTHING — the server broadcast a finished turn to the socket that died,
 * and it never re-pushes history to a reconnecting one. So a turn that lands
 * while the tab is in the FOREGROUND (no resume event, so no `onResume`
 * refetch) leaves a healthy socket showing stale content, which reads as a
 * hung turn. Observed on celld, which drops sockets on node restart and idle
 * eviction where Cloudflare hibernates them; reachable anywhere via an
 * abnormal close.
 *
 * `resync` therefore fires on the CLOSED→OPEN transition, not on every tick —
 * the watchdog runs every few seconds, and refetching history on each tick
 * while a socket stays down would hammer the endpoint.
 */
export function watchdogTick(
  nudged: boolean,
  readyState: number,
  isVisible: boolean,
  isOnline: boolean,
): { nudge: boolean; resync: boolean; nudged: boolean } {
  if (shouldNudgeReconnect(readyState, isVisible, isOnline)) {
    return { nudge: true, resync: false, nudged: true };
  }
  if (nudged && readyState === WS_OPEN) {
    return { nudge: false, resync: true, nudged: false };
  }
  return { nudge: false, resync: false, nudged };
}
