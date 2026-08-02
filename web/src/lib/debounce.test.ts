import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { debounce } from "./debounce";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("debounce", () => {
  it("collapses rapid calls into a single trailing call with the latest args", () => {
    const fn = vi.fn();
    const d = debounce(fn, 500);
    d("a");
    d("b");
    d("c");
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("c");
  });

  it("flush() runs the pending call immediately and only once", () => {
    const fn = vi.fn();
    const d = debounce(fn, 500);
    d("x");
    d.flush();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("x");
    vi.advanceTimersByTime(500);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("cancel() drops the pending call", () => {
    const fn = vi.fn();
    const d = debounce(fn, 500);
    d("y");
    d.cancel();
    vi.advanceTimersByTime(500);
    expect(fn).not.toHaveBeenCalled();
  });

  it("flush() with nothing pending is a no-op", () => {
    const fn = vi.fn();
    const d = debounce(fn, 500);
    d.flush();
    expect(fn).not.toHaveBeenCalled();
  });
});
