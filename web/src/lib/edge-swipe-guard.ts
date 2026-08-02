import { isStandaloneDisplay } from "./browser-notifications";

/**
 * Width of the left/right strips where the OS starts an interactive edge-swipe.
 * A touch above the rail's own 24px arming zone so the guard fully covers iOS's
 * back-swipe activation area.
 */
export const EDGE_GUARD_PX = 30;

/**
 * True when a touch that started in an edge strip has moved horizontally more
 * than vertically — i.e. it's the OS back/forward edge-swipe, not a scroll.
 * Pure so it can be unit-tested without a DOM.
 */
export function shouldPreventEdgeSwipe({
  startX,
  startY,
  x,
  y,
  innerWidth,
  edgePx = EDGE_GUARD_PX,
}: {
  startX: number;
  startY: number;
  x: number;
  y: number;
  innerWidth: number;
  edgePx?: number;
}): boolean {
  const startedAtEdge = startX <= edgePx || startX >= innerWidth - edgePx;
  if (!startedAtEdge) return false;
  return Math.abs(x - startX) > Math.abs(y - startY);
}

/**
 * Disable the OS/browser edge-swipe history navigation (back on the left edge,
 * forward on the right) while the app runs as an installed PWA.
 *
 * `overscroll-behavior-x: none` (index.css) already stops the Chrome/Android
 * overscroll-nav, but iOS Safari's interactive edge-swipe ignores it — so claim
 * the gesture directly: a horizontal-dominant swipe that starts in an edge strip
 * gets `preventDefault`'d before iOS commits to a navigation. The rail's own
 * left-edge drag still runs (preventDefault cancels only the browser default,
 * not our JS), so it keeps opening the rail.
 *
 * Standalone only: in a browser tab the edge-swipe is the user's expected way to
 * go back, so we leave it alone. Returns a teardown (used by tests); the app
 * calls it once for its lifetime and never tears down.
 */
export function installEdgeSwipeGuard(): (() => void) | undefined {
  if (typeof window === "undefined" || !isStandaloneDisplay()) return undefined;

  let startX = 0;
  let startY = 0;
  let armed = false;

  const onStart = (event: TouchEvent) => {
    if (event.touches.length !== 1) {
      armed = false;
      return;
    }
    const touch = event.touches[0]!;
    startX = touch.clientX;
    startY = touch.clientY;
    armed = startX <= EDGE_GUARD_PX || startX >= window.innerWidth - EDGE_GUARD_PX;
  };

  const onMove = (event: TouchEvent) => {
    if (!armed) return;
    const touch = event.touches[0];
    if (!touch) return;
    if (
      event.cancelable &&
      shouldPreventEdgeSwipe({
        startX,
        startY,
        x: touch.clientX,
        y: touch.clientY,
        innerWidth: window.innerWidth,
      })
    ) {
      event.preventDefault();
    }
  };

  // passive:false so preventDefault takes effect on the move.
  window.addEventListener("touchstart", onStart, { passive: true });
  window.addEventListener("touchmove", onMove, { passive: false });
  return () => {
    window.removeEventListener("touchstart", onStart);
    window.removeEventListener("touchmove", onMove);
  };
}
