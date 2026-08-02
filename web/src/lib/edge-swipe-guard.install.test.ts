// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const standalone = vi.fn(() => true);
vi.mock("./browser-notifications", () => ({ isStandaloneDisplay: () => standalone() }));

import { installEdgeSwipeGuard } from "./edge-swipe-guard";

function touchEvent(type: string, x: number, y: number, cancelable = false) {
  const event = new Event(type, { cancelable, bubbles: true });
  Object.defineProperty(event, "touches", { value: [{ clientX: x, clientY: y }] });
  return event;
}

let teardown: (() => void) | undefined;

beforeEach(() => {
  standalone.mockReturnValue(true);
  Object.defineProperty(window, "innerWidth", { value: 400, configurable: true });
});

afterEach(() => {
  teardown?.();
  teardown = undefined;
});

describe("installEdgeSwipeGuard", () => {
  it("prevents a horizontal swipe from the edge when installed", () => {
    teardown = installEdgeSwipeGuard();
    window.dispatchEvent(touchEvent("touchstart", 5, 100));
    const move = touchEvent("touchmove", 80, 108, true);
    const prevent = vi.spyOn(move, "preventDefault");
    window.dispatchEvent(move);
    expect(prevent).toHaveBeenCalledOnce();
  });

  it("leaves a vertical swipe (a scroll) alone", () => {
    teardown = installEdgeSwipeGuard();
    window.dispatchEvent(touchEvent("touchstart", 5, 100));
    const move = touchEvent("touchmove", 12, 260, true);
    const prevent = vi.spyOn(move, "preventDefault");
    window.dispatchEvent(move);
    expect(prevent).not.toHaveBeenCalled();
  });

  it("leaves a swipe that starts mid-screen alone", () => {
    teardown = installEdgeSwipeGuard();
    window.dispatchEvent(touchEvent("touchstart", 200, 100));
    const move = touchEvent("touchmove", 300, 105, true);
    const prevent = vi.spyOn(move, "preventDefault");
    window.dispatchEvent(move);
    expect(prevent).not.toHaveBeenCalled();
  });

  it("does nothing in a browser tab (not installed)", () => {
    standalone.mockReturnValue(false);
    teardown = installEdgeSwipeGuard();
    expect(teardown).toBeUndefined();
    window.dispatchEvent(touchEvent("touchstart", 5, 100));
    const move = touchEvent("touchmove", 80, 105, true);
    const prevent = vi.spyOn(move, "preventDefault");
    window.dispatchEvent(move);
    expect(prevent).not.toHaveBeenCalled();
  });
});
