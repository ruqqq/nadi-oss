import { useCallback, useEffect, useRef, useState } from "react";

/** Hold this long before it counts as a long press. */
export const LONG_PRESS_MS = 450;
/** Move more than this and it was a scroll, not a press. */
export const MOVE_TOLERANCE_PX = 10;

/**
 * Touch long-press. The rail's thread rows use it to reach the row menu on
 * mobile, where there is no hover to reveal a trigger.
 *
 * Three things make this safe to put on a scrollable list row:
 *  - A drag past MOVE_TOLERANCE_PX cancels the press, so flicking the rail
 *    never opens a menu. touchmove is never preventDefault-ed — the list has
 *    to keep scrolling underneath.
 *  - The tap that ends a long press is swallowed at capture, so opening the
 *    menu can't also select the thread.
 *  - contextmenu is suppressed while pressing, so Android's native menu and
 *    iOS's selection callout don't race the sheet.
 *
 * Touch only by design: mouse users get the visible ⋮ trigger instead.
 *
 * Returns `pressing` so the pressed element can show the wait: half a second
 * of nothing reads as a dead tap, not as a gesture in progress.
 */
export function useLongPress({
  onLongPress,
  enabled = true,
}: {
  onLongPress: () => void;
  enabled?: boolean;
}) {
  const timer = useRef<number | undefined>(undefined);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const onLongPressRef = useRef(onLongPress);
  const [pressing, setPressing] = useState(false);

  // Keep the callback fresh without re-creating the handlers on every render.
  useEffect(() => {
    onLongPressRef.current = onLongPress;
  }, [onLongPress]);

  const clear = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    start.current = null;
    setPressing(false);
  }, []);

  // A press in flight when the row unmounts must not fire into a dead tree.
  useEffect(() => clear, [clear]);

  const onTouchStart = useCallback(
    (event: React.TouchEvent) => {
      if (!enabled) return;
      // Multi-touch is a pinch or a zoom, never this.
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      if (!touch) return;

      fired.current = false;
      start.current = { x: touch.clientX, y: touch.clientY };
      setPressing(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        fired.current = true;
        start.current = null;
        // Release the press as the menu takes over — the surface is the
        // feedback from here on.
        setPressing(false);
        // Android/Chrome only; iOS ignores it. The sheet is the real feedback.
        navigator.vibrate?.(10);
        onLongPressRef.current();
      }, LONG_PRESS_MS);
    },
    [enabled],
  );

  const onTouchMove = useCallback(
    (event: React.TouchEvent) => {
      const origin = start.current;
      if (!origin) return;
      const touch = event.touches[0];
      if (!touch) return;
      const dx = Math.abs(touch.clientX - origin.x);
      const dy = Math.abs(touch.clientY - origin.y);
      if (dx > MOVE_TOLERANCE_PX || dy > MOVE_TOLERANCE_PX) clear();
    },
    [clear],
  );

  const onClickCapture = useCallback((event: React.MouseEvent) => {
    if (!fired.current) return;
    // The surface a long press opens is portalled to the body: its clicks reach
    // us through the React tree without ever being DOM descendants. Swallowing
    // one would eat the user's first tap on the menu they just opened. Only the
    // click the finger made on the row itself is ours to consume — a stale flag
    // is cleared by the next touchstart anyway.
    if (!event.currentTarget.contains(event.target as Node)) return;
    fired.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const onContextMenu = useCallback(
    (event: React.MouseEvent) => {
      if (!enabled) return;
      event.preventDefault();
    },
    [enabled],
  );

  return {
    /** True while a press is in flight — for showing the wait. */
    pressing,
    // Kept in their own object: `pressing` is not a DOM attribute, so the
    // caller must be able to spread the handlers without it.
    handlers: {
      onTouchStart,
      onTouchMove,
      onTouchEnd: clear,
      onTouchCancel: clear,
      onClickCapture,
      onContextMenu,
    },
  };
}
