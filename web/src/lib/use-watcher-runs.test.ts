// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWatcherRuns } from "./use-watcher-runs";

afterEach(() => {
  vi.useRealTimers();
});

describe("useWatcherRuns capability", () => {
  it("makes no status calls or timers while disabled", async () => {
    vi.useFakeTimers();
    const agent = { call: vi.fn(async () => []) };

    renderHook(() => useWatcherRuns(agent as never, [], false));
    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(15_000);
    });

    expect(agent.call).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
