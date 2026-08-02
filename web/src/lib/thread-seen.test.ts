import { describe, expect, test } from "vitest";
import { shouldMarkThreadSeen } from "./thread-seen";

describe("shouldMarkThreadSeen", () => {
  test("marks a visible thread that carries an unread outcome", () => {
    expect(shouldMarkThreadSeen({ unreadOutcome: "completed" }, true)).toBe(true);
    expect(shouldMarkThreadSeen({ unreadOutcome: "failed" }, true)).toBe(true);
  });

  test("does not mark while the tab is hidden — the user hasn't actually seen it", () => {
    expect(shouldMarkThreadSeen({ unreadOutcome: "completed" }, false)).toBe(false);
  });

  test("does nothing for a thread with no unread outcome", () => {
    expect(shouldMarkThreadSeen({ unreadOutcome: null }, true)).toBe(false);
  });

  test("tolerates a missing thread", () => {
    expect(shouldMarkThreadSeen(null, true)).toBe(false);
    expect(shouldMarkThreadSeen(undefined, true)).toBe(false);
  });
});
