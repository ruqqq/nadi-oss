import { describe, expect, it } from "vitest";
import { railToggleIndicator } from "./ThreadIndicator";
import type { ThreadSummary } from "../../threads-api";

function thread(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return { threadId: "thr_a", title: "Seed", ...overrides } as ThreadSummary;
}

describe("railToggleIndicator", () => {
  it("is null when nothing is waiting", () => {
    expect(railToggleIndicator([])).toBeNull();
    expect(railToggleIndicator([thread({ activityStatus: "idle" })])).toBeNull();
  });

  it("badges an unread outcome", () => {
    expect(railToggleIndicator([thread({ unreadOutcome: "completed" })])?.kind).toBe("unread");
    expect(railToggleIndicator([thread({ unreadOutcome: "failed" })])?.kind).toBe("unread");
  });

  it("badges an attention gate", () => {
    expect(railToggleIndicator([thread({ activityStatus: "attention_required" })])?.kind).toBe(
      "attention",
    );
  });

  it("does NOT badge a thread that is merely running", () => {
    // A turn in flight is not something you have missed. Badging it would light
    // the toggle for most of a working session.
    expect(railToggleIndicator([thread({ activityStatus: "running" })])).toBeNull();
  });

  it("lets attention outrank unread, whatever the order", () => {
    const unread = thread({ threadId: "thr_1", unreadOutcome: "completed" });
    const gate = thread({ threadId: "thr_2", activityStatus: "attention_required" });
    expect(railToggleIndicator([unread, gate])?.kind).toBe("attention");
    expect(railToggleIndicator([gate, unread])?.kind).toBe("attention");
  });

  it("scans past threads with no marker", () => {
    expect(
      railToggleIndicator([
        thread({ threadId: "thr_1" }),
        thread({ threadId: "thr_2", activityStatus: "running" }),
        thread({ threadId: "thr_3", unreadOutcome: "completed" }),
      ])?.kind,
    ).toBe("unread");
  });
});
