// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProgressiveList } from "./use-progressive-list";

/**
 * A controllable IntersectionObserver: jsdom has none, and the interesting
 * behaviour is *when* the callback fires, which a real one won't do here
 * anyway (nothing has layout).
 */
type Instance = {
  callback: IntersectionObserverCallback;
  observed: Element[];
  disconnected: boolean;
};
let instances: Instance[] = [];

function installObserver() {
  instances = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      callback: IntersectionObserverCallback;
      instance: Instance;
      constructor(callback: IntersectionObserverCallback) {
        this.callback = callback;
        this.instance = { callback, observed: [], disconnected: false };
        instances.push(this.instance);
      }
      observe(element: Element) {
        this.instance.observed.push(element);
      }
      disconnect() {
        this.instance.disconnected = true;
      }
      unobserve() {}
      takeRecords() {
        return [];
      }
    },
  );
}

/** Fire the newest live observer as if its sentinel scrolled into view. */
function intersect() {
  const live = instances.filter((i) => !i.disconnected);
  const latest = live[live.length - 1];
  if (!latest) throw new Error("no live observer to intersect");
  act(() => {
    latest.callback(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
  });
}

const items = (n: number) => Array.from({ length: n }, (_, i) => `item-${i}`);

describe("useProgressiveList", () => {
  beforeEach(installObserver);
  afterEach(() => vi.unstubAllGlobals());

  it("renders only the first page of a long list", () => {
    const { result } = renderHook(() =>
      useProgressiveList(items(100), { pageSize: 25, resetKey: "a" }),
    );
    expect(result.current.visible).toHaveLength(25);
    expect(result.current.hasMore).toBe(true);
    expect(result.current.remaining).toBe(75);
  });

  it("leaves a short list alone", () => {
    const { result } = renderHook(() =>
      useProgressiveList(items(3), { pageSize: 25, resetKey: "a" }),
    );
    expect(result.current.visible).toHaveLength(3);
    expect(result.current.hasMore).toBe(false);
    expect(result.current.remaining).toBe(0);
  });

  it("grows a page at a time as the end comes into view", () => {
    const { result } = renderHook(() =>
      useProgressiveList(items(60), { pageSize: 25, resetKey: "a" }),
    );
    act(() => result.current.sentinelRef(document.createElement("div")));

    intersect();
    expect(result.current.visible).toHaveLength(50);

    intersect();
    expect(result.current.visible).toHaveLength(60);
    expect(result.current.hasMore).toBe(false);
  });

  it("re-observes after each page, so a sentinel still on screen fires again", () => {
    // The wedge this guards: a real observer reports a *change* in intersection,
    // so a page landing with the sentinel still visible would never fire again
    // and the list would stop half-read. Re-observing re-reports the current
    // state. Asserting the observer is REPLACED is the only way to catch that —
    // the fake here fires on demand, so it would happily paper over the bug.
    const { result } = renderHook(() =>
      useProgressiveList(items(100), { pageSize: 25, resetKey: "a" }),
    );
    act(() => result.current.sentinelRef(document.createElement("div")));
    expect(instances).toHaveLength(1);

    intersect();
    expect(instances.length).toBeGreaterThan(1);
    expect(instances[0]?.disconnected).toBe(true);
    expect(instances.filter((i) => !i.disconnected)).toHaveLength(1);
  });

  it("stops observing once everything is shown", () => {
    const { result } = renderHook(() =>
      useProgressiveList(items(30), { pageSize: 25, resetKey: "a" }),
    );
    act(() => result.current.sentinelRef(document.createElement("div")));

    intersect();
    expect(result.current.hasMore).toBe(false);
    expect(instances.every((i) => i.disconnected)).toBe(true);
  });

  it("starts over when the list being read changes", () => {
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useProgressiveList(items(100), { pageSize: 25, resetKey: key }),
      { initialProps: { key: "project-a" } },
    );
    act(() => result.current.sentinelRef(document.createElement("div")));
    intersect();
    expect(result.current.visible).toHaveLength(50);

    rerender({ key: "project-b" });
    expect(result.current.visible).toHaveLength(25);
  });

  it("does not start over just because the caller rebuilt the array", () => {
    // Callers filter inline, so the array is a new object every render. Keying
    // the reset on it would snap the list back to page one forever — you could
    // never scroll past 25.
    const { result, rerender } = renderHook(() =>
      // A fresh array each render, exactly like `threads.filter(...)`.
      useProgressiveList([...items(100)], { pageSize: 25, resetKey: "a" }),
    );
    act(() => result.current.sentinelRef(document.createElement("div")));
    intersect();
    expect(result.current.visible).toHaveLength(50);

    rerender();
    expect(result.current.visible).toHaveLength(50);
  });

  it("grows without an IntersectionObserver, so the button still works", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const { result } = renderHook(() =>
      useProgressiveList(items(100), { pageSize: 25, resetKey: "a" }),
    );
    act(() => result.current.sentinelRef(document.createElement("div")));
    expect(result.current.visible).toHaveLength(25);

    act(() => result.current.showMore());
    expect(result.current.visible).toHaveLength(50);
  });
});
