// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { LONG_PRESS_MS, MOVE_TOLERANCE_PX, useLongPress } from "./use-long-press";

/**
 * The handlers take React synthetic events. Only the fields the hook reads are
 * modelled — a touch list and, for the click guard, the two methods it calls.
 */
function touch(x: number, y: number) {
  return { touches: [{ clientX: x, clientY: y }] } as unknown as React.TouchEvent;
}

function pinch(x: number, y: number) {
  return {
    touches: [
      { clientX: x, clientY: y },
      { clientX: x + 40, clientY: y },
    ],
  } as unknown as React.TouchEvent;
}

/**
 * A click carries the two nodes the guard reads. `target` defaults to a child
 * of the pressed row; pass an outside node to model a click inside a portalled
 * surface, which bubbles through the React tree without being a DOM descendant.
 */
function click(target?: Node) {
  const row = document.createElement("div");
  const child = document.createElement("button");
  row.append(child);
  const event = {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    currentTarget: row,
    target: target ?? child,
  };
  return event as unknown as React.MouseEvent & typeof event;
}

/** Stands in for the row's menu: React-tree descendant, DOM-tree stranger. */
function portalNode() {
  const portal = document.createElement("div");
  document.body.append(portal);
  return portal;
}

describe("useLongPress", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires after the hold, not before", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress({ onLongPress }));

    act(() => result.current.handlers.onTouchStart(touch(10, 10)));
    act(() => void vi.advanceTimersByTime(LONG_PRESS_MS - 1));
    expect(onLongPress).not.toHaveBeenCalled();

    act(() => void vi.advanceTimersByTime(1));
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it("does not fire when the press lifts early — that was a tap", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress({ onLongPress }));

    act(() => result.current.handlers.onTouchStart(touch(10, 10)));
    act(() => void vi.advanceTimersByTime(LONG_PRESS_MS - 50));
    act(() => result.current.handlers.onTouchEnd());
    act(() => void vi.advanceTimersByTime(500));

    expect(onLongPress).not.toHaveBeenCalled();
  });

  // The rail is a scrolling list: a flick that happens to start on a row must
  // never open a menu.
  it("cancels when the finger drags past the tolerance", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress({ onLongPress }));

    act(() => result.current.handlers.onTouchStart(touch(10, 10)));
    act(() => result.current.handlers.onTouchMove(touch(10, 10 + MOVE_TOLERANCE_PX + 1)));
    act(() => void vi.advanceTimersByTime(LONG_PRESS_MS + 50));

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("survives a jitter inside the tolerance — a still finger is never perfectly still", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress({ onLongPress }));

    act(() => result.current.handlers.onTouchStart(touch(10, 10)));
    act(() => result.current.handlers.onTouchMove(touch(12, 13)));
    act(() => void vi.advanceTimersByTime(LONG_PRESS_MS));

    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it("swallows the click that ends a long press, so the row is not also selected", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress({ onLongPress }));

    act(() => result.current.handlers.onTouchStart(touch(10, 10)));
    act(() => void vi.advanceTimersByTime(LONG_PRESS_MS));

    const event = click();
    act(() => result.current.handlers.onClickCapture(event));
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalled();
  });

  // The menu a long press opens is portalled to the body, but its clicks still
  // bubble through the React tree to the row. Swallowing those would eat the
  // user's first tap on "Archive" — the very action they held the row to reach.
  it("does not swallow clicks from a portalled surface", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress({ onLongPress }));

    act(() => result.current.handlers.onTouchStart(touch(10, 10)));
    act(() => void vi.advanceTimersByTime(LONG_PRESS_MS));

    const event = click(portalNode());
    act(() => result.current.handlers.onClickCapture(event));

    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("lets the next honest tap through after a long press", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress({ onLongPress }));

    act(() => result.current.handlers.onTouchStart(touch(10, 10)));
    act(() => void vi.advanceTimersByTime(LONG_PRESS_MS));
    act(() => result.current.handlers.onClickCapture(click()));

    // Second tap: short, no hold. It must reach the row.
    const event = click();
    act(() => result.current.handlers.onTouchStart(touch(10, 10)));
    act(() => result.current.handlers.onTouchEnd());
    act(() => result.current.handlers.onClickCapture(event));

    expect(event.stopPropagation).not.toHaveBeenCalled();
  });

  // `pressing` drives the row's press-in. Half a second of no feedback reads
  // as a dead tap, so it must track the press exactly.
  describe("pressing", () => {
    it("is true while holding and released when the menu takes over", () => {
      const onLongPress = vi.fn();
      const { result } = renderHook(() => useLongPress({ onLongPress }));

      expect(result.current.pressing).toBe(false);

      act(() => result.current.handlers.onTouchStart(touch(10, 10)));
      expect(result.current.pressing).toBe(true);

      act(() => void vi.advanceTimersByTime(LONG_PRESS_MS));
      expect(result.current.pressing).toBe(false);
    });

    it("clears when the press lifts early", () => {
      const onLongPress = vi.fn();
      const { result } = renderHook(() => useLongPress({ onLongPress }));

      act(() => result.current.handlers.onTouchStart(touch(10, 10)));
      act(() => result.current.handlers.onTouchEnd());

      expect(result.current.pressing).toBe(false);
    });

    // Otherwise a flick down the rail leaves the row stuck mid-press.
    it("clears when a drag cancels the press", () => {
      const onLongPress = vi.fn();
      const { result } = renderHook(() => useLongPress({ onLongPress }));

      act(() => result.current.handlers.onTouchStart(touch(10, 10)));
      act(() => result.current.handlers.onTouchMove(touch(10, 10 + MOVE_TOLERANCE_PX + 1)));

      expect(result.current.pressing).toBe(false);
    });

    it("stays false when disabled", () => {
      const onLongPress = vi.fn();
      const { result } = renderHook(() => useLongPress({ onLongPress, enabled: false }));

      act(() => result.current.handlers.onTouchStart(touch(10, 10)));

      expect(result.current.pressing).toBe(false);
    });
  });

  it("ignores a second finger — that is a pinch", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress({ onLongPress }));

    act(() => result.current.handlers.onTouchStart(pinch(10, 10)));
    act(() => void vi.advanceTimersByTime(LONG_PRESS_MS + 50));

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("does nothing when disabled", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress({ onLongPress, enabled: false }));

    act(() => result.current.handlers.onTouchStart(touch(10, 10)));
    act(() => void vi.advanceTimersByTime(LONG_PRESS_MS + 50));

    expect(onLongPress).not.toHaveBeenCalled();
  });

  // A pending timer that outlives the row would fire into a dead tree.
  it("cancels a press in flight when the row unmounts", () => {
    const onLongPress = vi.fn();
    const { result, unmount } = renderHook(() => useLongPress({ onLongPress }));

    act(() => result.current.handlers.onTouchStart(touch(10, 10)));
    unmount();
    act(() => void vi.advanceTimersByTime(LONG_PRESS_MS + 50));

    expect(onLongPress).not.toHaveBeenCalled();
  });
});
