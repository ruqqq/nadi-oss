import { describe, expect, it } from "vitest";
import {
  AUTOMATON_NUDGE_KEY,
  armAutomatonNudge,
  automatonNudgePrompt,
  hasCalendarTool,
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
  it("asks for calendar data only when a calendar tool resolved", () => {
    expect(automatonNudgePrompt({ calendarConnected: true })).toContain("calendar");
    expect(automatonNudgePrompt({ calendarConnected: false })).not.toContain("calendar");
  });

  it("always proposes a schedule", () => {
    for (const connected of [true, false]) {
      expect(automatonNudgePrompt({ calendarConnected: connected })).toContain("Every weekday");
    }
  });
});

describe("hasCalendarTool", () => {
  it("matches a plain calendar tool name", () => {
    expect(hasCalendarTool(["calendar_list_events"])).toBe(true);
  });

  it("is case-insensitive and tolerates a vendor prefix", () => {
    expect(hasCalendarTool(["GOOGLECALENDAR_FIND_EVENT"])).toBe(true);
    expect(hasCalendarTool(["GoogleCalendar_findEvent"])).toBe(true);
  });

  it("does not match when Composio is connected but no calendar tool is present", () => {
    // Regression test for the reported bug: Composio (the platform) finishing
    // OAuth is not the same as a calendar account being connected inside it.
    expect(hasCalendarTool(["gmail_send_email", "gmail_list_threads"])).toBe(false);
  });

  it("does not claim a calendar when the tool list is empty or failed to load", () => {
    expect(hasCalendarTool([])).toBe(false);
  });
});

describe("arm/take", () => {
  it("returns the armed prompt exactly once", () => {
    const storage = fakeStorage();
    armAutomatonNudge(storage, { calendarConnected: false });
    const first = takeAutomatonNudge(storage);
    expect(first).toBe(automatonNudgePrompt({ calendarConnected: false }));
    expect(takeAutomatonNudge(storage)).toBe(null);
  });

  it("is null when never armed", () => {
    expect(takeAutomatonNudge(fakeStorage())).toBe(null);
  });

  it("clears the key when taken", () => {
    const storage = fakeStorage();
    armAutomatonNudge(storage, { calendarConnected: true });
    takeAutomatonNudge(storage);
    expect(storage.getItem(AUTOMATON_NUDGE_KEY)).toBe(null);
  });
});
