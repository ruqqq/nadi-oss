import { describe, expect, it } from "vitest";
import {
  DEFAULT_MONITOR_POLL_INTERVAL_MS,
  MAX_WATCHERS_PER_THREAD,
  WATCH_ABSOLUTE_TIMEOUT_MS,
  canAddWatcher,
  classifyWatcher,
  nextWakeAt,
  type WatcherRow,
} from "../../../src/compute/watchers";

function watcher(overrides?: Partial<WatcherRow>): WatcherRow {
  return {
    processId: "p1",
    deadlineAt: 1000,
    pollIntervalMs: DEFAULT_MONITOR_POLL_INTERVAL_MS,
    nextPollAt: 500,
    label: null,
    createdAt: 0,
    ...overrides,
  };
}

describe("classifyWatcher", () => {
  it("returns exited for every terminal status regardless of deadline", () => {
    for (const status of ["exited", "failed", "stopped"] as const) {
      expect(
        classifyWatcher({ watcher: watcher({ deadlineAt: 1000 }), processStatus: status, now: 0 }),
      ).toBe("exited");
      expect(
        classifyWatcher({
          watcher: watcher({ deadlineAt: 1000 }),
          processStatus: status,
          now: 2000,
        }),
      ).toBe("exited");
    }
  });

  it("returns pending while running and before the deadline", () => {
    expect(
      classifyWatcher({
        watcher: watcher({ deadlineAt: 1000 }),
        processStatus: "running",
        now: 999,
      }),
    ).toBe("pending");
  });

  it("returns renew when now === deadlineAt (boundary) while still running and under the absolute cap", () => {
    expect(
      classifyWatcher({
        watcher: watcher({ deadlineAt: 1000, createdAt: 0 }),
        processStatus: "running",
        now: 1000,
      }),
    ).toBe("renew");
  });

  it("returns renew when now is past the deadline but before the absolute cap while still running", () => {
    expect(
      classifyWatcher({
        watcher: watcher({ deadlineAt: 1000, createdAt: 0 }),
        processStatus: "running",
        now: 1500,
      }),
    ).toBe("renew");
  });

  it("returns timeout when now reaches the absolute cap while still running", () => {
    expect(
      classifyWatcher({
        watcher: watcher({ deadlineAt: 1000, createdAt: 0 }),
        processStatus: "running",
        now: WATCH_ABSOLUTE_TIMEOUT_MS,
      }),
    ).toBe("timeout");
  });

  it("returns timeout when now is past the absolute cap while still running", () => {
    expect(
      classifyWatcher({
        watcher: watcher({ deadlineAt: 1000, createdAt: 0 }),
        processStatus: "running",
        now: WATCH_ABSOLUTE_TIMEOUT_MS + 1,
      }),
    ).toBe("timeout");
  });
});

describe("nextWakeAt", () => {
  it("returns null when there are no watchers and no eviction", () => {
    expect(nextWakeAt([], null)).toBeNull();
  });

  it("returns evictAt when there are no watchers", () => {
    expect(nextWakeAt([], 5000)).toBe(5000);
  });

  it("returns the minimum nextPollAt when evictAt is null", () => {
    const watchers = [watcher({ nextPollAt: 300 }), watcher({ nextPollAt: 100 })];
    expect(nextWakeAt(watchers, null)).toBe(100);
  });

  it("returns the minimum across watchers and eviction", () => {
    const watchers = [watcher({ nextPollAt: 300 }), watcher({ nextPollAt: 700 })];
    expect(nextWakeAt(watchers, 500)).toBe(300);
    expect(nextWakeAt(watchers, 200)).toBe(200);
  });

  // The work-ledger horizon is folded in HERE rather than armed separately,
  // because the scheduler is cancel-then-set on a single id: a second arm
  // point does not add an alarm, it replaces this one. Folding makes a later
  // horizon a no-op instead of a delay.
  it("ignores the work horizon when it is LATER than the next watcher poll", () => {
    // The steady state for a healthy watched process: the poll just stamped
    // liveness, so the ledger horizon (stamp + 21s) always sits well past the
    // next poll (stamp + 7s). It must not push the poll out.
    const watchers = [watcher({ nextPollAt: 7_000 })];
    expect(nextWakeAt(watchers, null, 21_000)).toBe(7_000);
  });

  it("uses the work horizon when it is EARLIER than the next watcher poll", () => {
    const watchers = [watcher({ nextPollAt: 7_000 })];
    expect(nextWakeAt(watchers, null, 3_000)).toBe(3_000);
  });

  it("uses the work horizon when it is the only reason to wake", () => {
    expect(nextWakeAt([], null, 9_000)).toBe(9_000);
  });

  it("takes the minimum across watchers, eviction AND the work horizon", () => {
    const watchers = [watcher({ nextPollAt: 700 })];
    expect(nextWakeAt(watchers, 500, 300)).toBe(300);
    expect(nextWakeAt(watchers, 300, 500)).toBe(300);
    expect(nextWakeAt(watchers, 900, 800)).toBe(700);
  });

  it("treats a null work horizon (no open work) as no constraint", () => {
    expect(nextWakeAt([], 5_000, null)).toBe(5_000);
    expect(nextWakeAt([], null, null)).toBeNull();
  });
});

describe("canAddWatcher", () => {
  it("allows adding when under the cap", () => {
    expect(canAddWatcher(7)).toBe(true);
  });

  it("blocks adding at the cap", () => {
    expect(canAddWatcher(MAX_WATCHERS_PER_THREAD)).toBe(false);
    expect(canAddWatcher(8)).toBe(false);
  });
});
