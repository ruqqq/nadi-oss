/**
 * "Is anyone actually at this client right now", for push suppression.
 *
 * `document.visibilityState` is not that question. A tab left frontmost on a
 * desk reports `visible` forever, and because push suppression is per user,
 * one such tab silenced notifications on every device the account owns.
 *
 * A phone needs none of this — locking the screen hides the page and stops its
 * timers, so it goes away on visibility alone, usually inside 30s. This exists
 * for the desktop case: screen on, tab frontmost, nobody there.
 */

/**
 * How long without a single interaction before we stop claiming someone is
 * here. Presence is re-sent every 30s, so the server learns 60–90s after the
 * user actually stepped away.
 *
 * Short on purpose: the cost of being wrong is one extra notification while you
 * are reading, and the cost of being wrong the other way is silence.
 */
export const IDLE_AFTER_MS = 60_000;

/**
 * Events that mean a human did something. Deliberately excludes `visibilitychange`
 * and timers — returning to a tab is handled by `visible`, and a tab that merely
 * ticks is exactly what this exists to catch.
 */
export const ACTIVITY_EVENTS = [
  "pointerdown",
  "pointermove",
  "keydown",
  "wheel",
  "scroll",
  "touchstart",
  "focus",
] as const;

export function isUserActive(input: {
  visible: boolean;
  lastInteractionAt: number;
  now: number;
  idleAfterMs?: number;
}): boolean {
  if (!input.visible) return false;
  return input.now - input.lastInteractionAt < (input.idleAfterMs ?? IDLE_AFTER_MS);
}

/**
 * Record interactions into a mutable holder. Returns the teardown.
 *
 * Writes a timestamp and nothing else — no state, no re-render. `pointermove`
 * and `scroll` fire continuously, and re-rendering the app on every one of them
 * to track idleness would cost far more than the feature is worth.
 */
export function trackUserActivity(
  holder: { current: number },
  target: Pick<EventTarget, "addEventListener" | "removeEventListener"> = window,
  now: () => number = Date.now,
): () => void {
  const mark = () => {
    holder.current = now();
  };
  for (const event of ACTIVITY_EVENTS) {
    target.addEventListener(event, mark, { passive: true, capture: true });
  }
  return () => {
    for (const event of ACTIVITY_EVENTS) {
      target.removeEventListener(event, mark, { capture: true });
    }
  };
}
