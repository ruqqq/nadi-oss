import { describe, expect, it } from "vitest";
import {
  AUTOMATON_NUDGE_KEY,
  armAutomatonNudge,
  automatonNudgePrompt,
  takeAutomatonNudge,
} from "./automaton-nudge";

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    size: () => map.size,
  };
}

describe("automatonNudgePrompt", () => {
  it("asks for calendar data only when Composio is connected", () => {
    expect(automatonNudgePrompt({ composioConnected: true })).toContain("calendar");
    expect(automatonNudgePrompt({ composioConnected: false })).not.toContain("calendar");
  });

  it("always proposes a schedule", () => {
    for (const connected of [true, false]) {
      expect(automatonNudgePrompt({ composioConnected: connected })).toContain("Every weekday");
    }
  });
});

describe("arm/take", () => {
  it("returns the armed prompt exactly once", () => {
    const storage = fakeStorage();
    armAutomatonNudge(storage, { composioConnected: false });
    const first = takeAutomatonNudge(storage);
    expect(first).toBe(automatonNudgePrompt({ composioConnected: false }));
    expect(takeAutomatonNudge(storage)).toBe(null);
  });

  it("is null when never armed", () => {
    expect(takeAutomatonNudge(fakeStorage())).toBe(null);
  });

  it("clears the key when taken", () => {
    const storage = fakeStorage();
    armAutomatonNudge(storage, { composioConnected: true });
    takeAutomatonNudge(storage);
    expect(storage.getItem(AUTOMATON_NUDGE_KEY)).toBe(null);
  });
});
