// @vitest-environment jsdom
import { createElement } from "react";
import { act, render, renderHook, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useThreadQuery } from "./use-thread-query";
import type { ThreadSummary } from "../threads-api";

function thread(over: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    threadId: "t1",
    kind: "regular",
    workspaceId: "w1",
    agentId: "a1",
    provider: "openai-oauth",
    model: "gpt-5.5",
    modelInputModalities: ["text"],
    runtime: "legacy",
    title: "Title",
    source: "manual",
    lastMessagePreview: "",
    archivedAt: null,
    readOnly: true,
    status: "active",
    projectId: null,
    projectName: null,
    agentName: null,
    automatonId: null,
    automatonName: null,
    automatonNotifyMode: null,
    outcomeDismissedAt: null,
    repositoryCount: 0,
    createdAt: 1,
    updatedAt: 1,
    lastContextTokens: null,
    lastContextWindow: null,
    lastCompactAfterTokens: null,
    ...over,
  } as ThreadSummary;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** A controllable fetchPage: each call gets its own deferred promise, resolved on demand. */
function deferredFetchPage() {
  const calls: Array<{
    cursor: string | undefined;
    resolve: (v: { threads: ThreadSummary[]; nextCursor: string | null }) => void;
    reject: (e: Error) => void;
  }> = [];
  const fetchPage = vi.fn((cursor?: string) => {
    return new Promise<{ threads: ThreadSummary[]; nextCursor: string | null }>(
      (resolve, reject) => {
        calls.push({ cursor, resolve, reject });
      },
    );
  });
  return { fetchPage, calls };
}

describe("useThreadQuery", () => {
  it("fetches page one on mount and reports via onPage with reset: true", async () => {
    const { fetchPage, calls } = deferredFetchPage();
    const onPage = vi.fn();
    const { result } = renderHook(() =>
      useThreadQuery({ key: "active|all|", fetchPage, onPage }),
    );
    expect(result.current.loading).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cursor).toBeUndefined();

    await act(async () => {
      calls[0]?.resolve({ threads: [thread({ threadId: "t1" })], nextCursor: "c1" });
    });

    expect(onPage).toHaveBeenCalledWith([thread({ threadId: "t1" })], { reset: true });
    expect(result.current.loading).toBe(false);
    expect(result.current.exhausted).toBe(false);
    expect(result.current.hasMore).toBe(true);
  });

  it("refetches page one when key changes, clearing exhausted", async () => {
    const { fetchPage, calls } = deferredFetchPage();
    const onPage = vi.fn();
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useThreadQuery({ key, fetchPage, onPage }),
      { initialProps: { key: "active|all|" } },
    );
    await act(async () => {
      calls[0]?.resolve({ threads: [thread()], nextCursor: null });
    });
    expect(result.current.exhausted).toBe(true);

    rerender({ key: "active|all|dep" });
    expect(result.current.exhausted).toBe(false);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.cursor).toBeUndefined();

    await act(async () => {
      calls[1]?.resolve({ threads: [thread({ threadId: "t2" })], nextCursor: null });
    });
    expect(onPage).toHaveBeenLastCalledWith([thread({ threadId: "t2" })], { reset: true });
  });

  it("loadMore passes the previous cursor and calls onPage with reset: false", async () => {
    const { fetchPage, calls } = deferredFetchPage();
    const onPage = vi.fn();
    const { result } = renderHook(() =>
      useThreadQuery({ key: "active|all|", fetchPage, onPage }),
    );
    await act(async () => {
      calls[0]?.resolve({ threads: [thread()], nextCursor: "cursor-1" });
    });

    act(() => result.current.loadMore());
    expect(calls).toHaveLength(2);
    expect(calls[1]?.cursor).toBe("cursor-1");

    await act(async () => {
      calls[1]?.resolve({ threads: [thread({ threadId: "t2" })], nextCursor: null });
    });
    expect(onPage).toHaveBeenLastCalledWith([thread({ threadId: "t2" })], { reset: false });
    expect(result.current.exhausted).toBe(true);
    expect(result.current.hasMore).toBe(false);
  });

  it("exhausted is false until a page returns nextCursor: null", async () => {
    const { fetchPage, calls } = deferredFetchPage();
    const onPage = vi.fn();
    const { result } = renderHook(() =>
      useThreadQuery({ key: "active|all|", fetchPage, onPage }),
    );
    await act(async () => {
      calls[0]?.resolve({ threads: [thread()], nextCursor: "c1" });
    });
    expect(result.current.exhausted).toBe(false);

    act(() => result.current.loadMore());
    await act(async () => {
      calls[1]?.resolve({ threads: [thread()], nextCursor: null });
    });
    expect(result.current.exhausted).toBe(true);
  });

  it("discards a stale response: key changes mid-flight, and the old fetch resolving LAST does not apply", async () => {
    const { fetchPage, calls } = deferredFetchPage();
    const onPage = vi.fn();
    const { rerender, result } = renderHook(
      ({ key }: { key: string }) => useThreadQuery({ key, fetchPage, onPage }),
      { initialProps: { key: "dep" } },
    );
    expect(calls).toHaveLength(1);

    rerender({ key: "deploy" });
    expect(calls).toHaveLength(2);

    // The NEW ("deploy") fetch resolves FIRST.
    await act(async () => {
      calls[1]?.resolve({ threads: [thread({ threadId: "deploy-1" })], nextCursor: null });
    });
    expect(onPage).toHaveBeenCalledTimes(1);
    expect(onPage).toHaveBeenLastCalledWith([thread({ threadId: "deploy-1" })], { reset: true });
    expect(result.current.exhausted).toBe(true);

    // The STALE ("dep") fetch resolves LAST — must be discarded entirely.
    await act(async () => {
      calls[0]?.resolve({ threads: [thread({ threadId: "dep-1" })], nextCursor: "stale-cursor" });
    });
    expect(onPage).toHaveBeenCalledTimes(1);
    expect(result.current.exhausted).toBe(true);
    expect(result.current.hasMore).toBe(false);

    // loadMore must page the CURRENT ("deploy") query, not the stale one.
    act(() => result.current.loadMore());
    expect(calls).toHaveLength(2);
  });

  it("loadMore while already loading is a no-op", async () => {
    const { fetchPage, calls } = deferredFetchPage();
    const onPage = vi.fn();
    const { result } = renderHook(() =>
      useThreadQuery({ key: "active|all|", fetchPage, onPage }),
    );
    await act(async () => {
      calls[0]?.resolve({ threads: [thread()], nextCursor: "c1" });
    });

    act(() => result.current.loadMore());
    expect(calls).toHaveLength(2);

    // Fires while the loadMore fetch is still in flight — must not issue a third call.
    act(() => result.current.loadMore());
    expect(calls).toHaveLength(2);

    await act(async () => {
      calls[1]?.resolve({ threads: [thread({ threadId: "t2" })], nextCursor: "c2" });
    });
    expect(onPage).toHaveBeenCalledTimes(2);
  });

  it("a rejected fetch sets error without setting exhausted", async () => {
    const { fetchPage, calls } = deferredFetchPage();
    const onPage = vi.fn();
    const { result } = renderHook(() =>
      useThreadQuery({ key: "active|all|", fetchPage, onPage }),
    );
    const err = new Error("offline");
    await act(async () => {
      calls[0]?.reject(err);
    });

    expect(result.current.error).toBe(err);
    expect(result.current.exhausted).toBe(false);
    expect(result.current.loading).toBe(false);
    expect(onPage).not.toHaveBeenCalled();
  });

  it("enabled: false fetches nothing", async () => {
    const { fetchPage, calls } = deferredFetchPage();
    const onPage = vi.fn();
    const { result } = renderHook(() =>
      useThreadQuery({ key: "active|all|", fetchPage, onPage, enabled: false }),
    );
    expect(calls).toHaveLength(0);
    expect(result.current.loading).toBe(false);

    act(() => result.current.loadMore());
    expect(calls).toHaveLength(0);
  });

  it("a loadMore reference captured once (as an IntersectionObserver effect would) stays inert after exhaustion", async () => {
    const { fetchPage, calls } = deferredFetchPage();
    const onPage = vi.fn();
    const { result } = renderHook(() =>
      useThreadQuery({ key: "active|all|", fetchPage, onPage }),
    );

    // Capture loadMore ONCE, before exhaustion — mimics an effect with `[]` deps
    // that observes an IntersectionObserver sentinel.
    const capturedLoadMore = result.current.loadMore;

    await act(async () => {
      calls[0]?.resolve({ threads: [thread()], nextCursor: "c1" });
    });

    act(() => capturedLoadMore());
    expect(calls).toHaveLength(2);
    expect(calls[1]?.cursor).toBe("c1");

    await act(async () => {
      calls[1]?.resolve({ threads: [thread({ threadId: "t2" })], nextCursor: null });
    });
    expect(result.current.exhausted).toBe(true);

    // Sentinel intersects again with the STALE captured reference.
    act(() => capturedLoadMore());
    expect(calls).toHaveLength(2);
    expect(onPage).toHaveBeenCalledTimes(2);
    expect(onPage).not.toHaveBeenNthCalledWith(3, expect.anything(), { reset: true });
  });

  it("hasMore is false on the pre-effect render, before any fetch has started", () => {
    const fetchPage = vi.fn(
      () => new Promise<{ threads: ThreadSummary[]; nextCursor: string | null }>(() => {}),
    );
    const onPage = vi.fn();
    // Capture hasMore during the render function body itself — this runs
    // BEFORE React commits and fires the effect that kicks off the page-one
    // fetch, so it observes the exact frame the review flagged.
    const seenHasMore: boolean[] = [];
    function Probe() {
      const { hasMore } = useThreadQuery({ key: "active|all|", fetchPage, onPage });
      seenHasMore.push(hasMore);
      return null;
    }
    render(createElement(Probe));
    expect(seenHasMore[0]).toBe(false);
  });

  it("hasMore stays false permanently when enabled: false, since no fetch is ever started", () => {
    const { fetchPage, calls } = deferredFetchPage();
    const onPage = vi.fn();
    const { result } = renderHook(() =>
      useThreadQuery({ key: "active|all|", fetchPage, onPage, enabled: false }),
    );
    expect(calls).toHaveLength(0);
    expect(result.current.hasMore).toBe(false);
  });

  it("unmount invalidates an in-flight fetch: it must not call onPage after the component is gone", async () => {
    const { fetchPage, calls } = deferredFetchPage();
    const onPage = vi.fn();
    const { unmount } = renderHook(() =>
      useThreadQuery({ key: "active|all|", fetchPage, onPage }),
    );
    expect(calls).toHaveLength(1);

    unmount();

    await act(async () => {
      calls[0]?.resolve({ threads: [thread()], nextCursor: null });
    });
    expect(onPage).not.toHaveBeenCalled();
  });

  it("reload refetches page one, resetting exhausted", async () => {
    const { fetchPage, calls } = deferredFetchPage();
    const onPage = vi.fn();
    const { result } = renderHook(() =>
      useThreadQuery({ key: "active|all|", fetchPage, onPage }),
    );
    await act(async () => {
      calls[0]?.resolve({ threads: [thread()], nextCursor: null });
    });
    expect(result.current.exhausted).toBe(true);

    act(() => result.current.reload());
    expect(calls).toHaveLength(2);
    expect(calls[1]?.cursor).toBeUndefined();
    expect(result.current.exhausted).toBe(false);

    await act(async () => {
      calls[1]?.resolve({ threads: [thread({ threadId: "t2" })], nextCursor: null });
    });
    expect(onPage).toHaveBeenLastCalledWith([thread({ threadId: "t2" })], { reset: true });
  });
});
