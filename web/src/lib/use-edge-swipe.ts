import { useEffect, useRef } from "react";

/**
 * Drag in from the left edge to open the thread rail — the rail tracks the
 * finger rather than snapping when a threshold trips.
 *
 * The browser claims that same gesture for history-back, so a swipe would
 * otherwise do two things at once. We take it: the gesture only arms inside a
 * narrow strip at the edge, and once armed we preventDefault the move, which is
 * what stops Safari's interactive back-swipe running alongside us. (An
 * installed PWA has no back gesture, so there it is ours from the start.)
 *
 * The rail is a Radix Sheet, which only mounts while open — so the drag opens it
 * immediately and drives its transform through a CSS variable, with Radix's own
 * enter/exit animation suppressed for the duration (see index.css). Releasing
 * below the threshold closes it again. That keeps the Sheet's focus trap, scroll
 * lock and Escape handling instead of reimplementing a drawer.
 */

/** How far from the edge a touch must start to arm the gesture. */
export const EDGE_WIDTH_PX = 24;
/** Past this much vertical drift it's a scroll, not a swipe. */
export const SLOP_PX = 16;
/** Release past this fraction of the rail's width and it settles open. */
export const OPEN_PROGRESS = 0.35;
/** …or release below it fast enough, and the fling still opens it (px/ms). */
export const FLING_VELOCITY = 0.4;
/** How long the rail takes to settle to open after release. */
export const SETTLE_MS = 180;
/** Radix's exit animation — hold the drag styles until it has unmounted. */
export const CLOSE_MS = 320;

/**
 * Where a released open-drag lands. A short but fast flick opens: honouring
 * velocity is what separates a flick from a hesitant half-drag the user thought
 * better of.
 */
export function settlesOpen(progress: number, velocity: number): boolean {
  if (velocity >= FLING_VELOCITY) return true;
  return progress >= OPEN_PROGRESS;
}

/**
 * …and where a released close-drag lands. Same shape, mirrored: a leftward fling
 * closes, and so does dragging the rail more than OPEN_PROGRESS of the way out.
 */
export function settlesClosed(progress: number, velocity: number): boolean {
  if (velocity <= -FLING_VELOCITY) return true;
  return progress <= 1 - OPEN_PROGRESS;
}

export function useLeftEdgeDrawerDrag({
  enabled,
  isOpen,
  widthPx,
  onOpenChange,
}: {
  /** Off on desktop, where the rail is pinned rather than a drawer. */
  enabled: boolean;
  /** Already open — a drag would have nothing to do. */
  isOpen: boolean;
  widthPx: number;
  onOpenChange: (open: boolean) => void;
}) {
  // Read through a ref, never a dependency: the drag *itself* opens the rail, so
  // depending on `isOpen` would tear this effect down mid-gesture — dropping the
  // listeners and the drag styles, and leaving Radix's slide-in animation to
  // finish the job instead of the finger.
  const openRef = useRef(isOpen);
  openRef.current = isOpen;
  // True only while the drag itself is closing the rail — see below.
  const dragClosingRef = useRef(false);

  // Once the rail is open the drag styles stay on, pinning it at fully-open.
  // They can only be dropped when it closes: un-suppressing Radix's animation
  // while the rail is still up makes its 500ms slide-in restart from scratch.
  useEffect(() => {
    if (isOpen || dragClosingRef.current) return;
    document.body.removeAttribute("data-rail-dragging");
    document.body.removeAttribute("data-rail-settling");
    document.documentElement.style.removeProperty("--rail-drag");
  }, [isOpen]);

  useEffect(() => {
    if (!enabled) return;

    const root = document.documentElement;
    const body = document.body;
    let startX: number | null = null;
    let startY = 0;
    let dragging = false;
    let mode: "open" | "close" = "open";
    let lastX = 0;
    let lastAt = 0;
    let velocity = 0;
    let settleTimer: number | undefined;

    const setProgress = (progress: number) => {
      root.style.setProperty("--rail-drag", String(progress));
    };

    const clearDragStyles = () => {
      body.removeAttribute("data-rail-dragging");
      body.removeAttribute("data-rail-settling");
      root.style.removeProperty("--rail-drag");
    };

    const onTouchStart = (event: TouchEvent) => {
      // Multi-touch is a pinch or a zoom, never this.
      if (event.touches.length !== 1) return;
      const touch = event.touches[0]!;
      const target = event.target as Element | null;

      if (openRef.current) {
        // Closing. Only from the rail itself or its scrim — not from a dialog
        // above it.
        if (!target?.closest('[data-rail], [data-slot="sheet-overlay"]')) return;
        mode = "close";
      } else {
        // Opening. A modal owns the screen while it's up (Radix locks the body);
        // don't race it.
        if (body.hasAttribute("data-scroll-locked")) return;
        if (touch.clientX > EDGE_WIDTH_PX) return;
        mode = "open";
      }

      window.clearTimeout(settleTimer);
      startX = touch.clientX;
      startY = touch.clientY;
      lastX = touch.clientX;
      lastAt = performance.now();
      velocity = 0;
      dragging = false;
    };

    const onTouchMove = (event: TouchEvent) => {
      if (startX === null) return;
      const touch = event.touches[0];
      if (!touch) return;

      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;

      if (!dragging) {
        // Decide once what this gesture is. A mostly-vertical move is a scroll
        // (the rail's own thread list, or the page) and must be left alone.
        if (Math.abs(dy) > SLOP_PX && Math.abs(dy) > Math.abs(dx)) {
          startX = null;
          return;
        }
        if (mode === "open" ? dx < SLOP_PX : dx > -SLOP_PX) return;
        dragging = true;
        body.setAttribute("data-rail-dragging", "");
        body.removeAttribute("data-rail-settling");
        setProgress(mode === "open" ? 0 : 1);
        // Opening: mount the Sheet so there is something to drag. Its animation
        // is suppressed while data-rail-dragging is set, so it doesn't fly in.
        if (mode === "open") onOpenChange(true);
      }

      const now = performance.now();
      const elapsed = now - lastAt;
      if (elapsed > 0) velocity = (touch.clientX - lastX) / elapsed;
      lastX = touch.clientX;
      lastAt = now;

      // Claim the gesture from the browser's back-swipe while it's still ours.
      if (event.cancelable) event.preventDefault();
      const progress = mode === "open" ? dx / widthPx : 1 + dx / widthPx;
      setProgress(Math.max(0, Math.min(1, progress)));
    };

    const onTouchEnd = (event: TouchEvent) => {
      if (startX === null || !dragging) {
        startX = null;
        return;
      }
      const touch = event.changedTouches[0];
      const dx = touch ? touch.clientX - startX : 0;
      const raw = mode === "open" ? dx / widthPx : 1 + dx / widthPx;
      const progress = Math.max(0, Math.min(1, raw));
      const open =
        mode === "open" ? settlesOpen(progress, velocity) : !settlesClosed(progress, velocity);

      startX = null;
      dragging = false;

      body.setAttribute("data-rail-settling", "");
      setProgress(open ? 1 : 0);

      if (open) {
        // Glide the rest of the way and stay there. The styles are left in place
        // (holding it at fully-open) until something actually closes the rail —
        // clearing them here would restart Radix's slide-in under our feet.
        return;
      }
      // Closing: tell Radix now, but hold the drag styles until its exit
      // animation is done — dropping them early would snap the rail into view
      // for a frame before it slid away.
      dragClosingRef.current = true;
      onOpenChange(false);
      settleTimer = window.setTimeout(() => {
        clearDragStyles();
        dragClosingRef.current = false;
      }, CLOSE_MS);
    };

    // passive:false — preventDefault is the whole point of the move handler.
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", onTouchEnd);
    window.addEventListener("touchcancel", onTouchEnd);
    return () => {
      window.clearTimeout(settleTimer);
      clearDragStyles();
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [enabled, widthPx, onOpenChange]);
}
