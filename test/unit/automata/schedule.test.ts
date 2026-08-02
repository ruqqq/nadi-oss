import { describe, expect, it } from "vitest";
import {
  computeNextDueAt,
  describeSchedule,
  isValidTimezone,
  parseSchedule,
  scheduleToCron,
} from "../../../src/automata/schedule";

const at = (iso: string) => new Date(iso).getTime();
const iso = (ms: number) => new Date(ms).toISOString();

describe("scheduleToCron", () => {
  it("normalizes every preset to an equivalent cron expression", () => {
    expect(scheduleToCron({ kind: "hourly", minute: 0 })).toBe("0 * * * *");
    expect(scheduleToCron({ kind: "daily", hour: 8, minute: 30 })).toBe("30 8 * * *");
    expect(scheduleToCron({ kind: "weekdays", hour: 8, minute: 0 })).toBe("0 8 * * 1-5");
    expect(scheduleToCron({ kind: "weekly", weekday: 1, hour: 8, minute: 0 })).toBe("0 8 * * 1");
  });

  it("passes a raw cron expression through untouched", () => {
    expect(scheduleToCron({ kind: "cron", expr: "*/15 9-17 * * 1-5" })).toBe("*/15 9-17 * * 1-5");
  });
});

describe("computeNextDueAt", () => {
  it("resolves a preset against its timezone, not UTC", () => {
    // 08:00 Asia/Singapore (UTC+8) is 00:00Z.
    const next = computeNextDueAt(
      { kind: "daily", hour: 8, minute: 0 },
      "Asia/Singapore",
      at("2026-07-09T01:00:00Z"),
    );
    expect(iso(next)).toBe("2026-07-10T00:00:00.000Z");
  });

  it("is exclusive of `after`, so rolling forward from a due instant lands on the next one", () => {
    const due = at("2026-07-10T00:00:00Z");
    const next = computeNextDueAt({ kind: "daily", hour: 8, minute: 0 }, "Asia/Singapore", due);
    expect(iso(next)).toBe("2026-07-11T00:00:00.000Z");
  });

  it("skips the weekend for a weekdays preset", () => {
    // 2026-07-11 is a Saturday.
    const next = computeNextDueAt(
      { kind: "weekdays", hour: 8, minute: 0 },
      "Asia/Singapore",
      at("2026-07-11T00:00:00Z"),
    );
    expect(iso(next)).toBe("2026-07-13T00:00:00.000Z"); // Monday
  });

  it("fires once on a DST spring-forward day, when the local hour does not exist", () => {
    // America/New_York 2026-03-08: 02:00 -> 03:00. A 02:30 automaton has no 02:30.
    // It fires at 07:30Z, which is 03:30 EDT — one wall-clock hour late, exactly once.
    const next = computeNextDueAt(
      { kind: "daily", hour: 2, minute: 30 },
      "America/New_York",
      at("2026-03-07T12:00:00Z"),
    );
    expect(iso(next)).toBe("2026-03-08T07:30:00.000Z");
    // The following day is back to 02:30 local (EDT = UTC-4).
    expect(
      iso(computeNextDueAt({ kind: "daily", hour: 2, minute: 30 }, "America/New_York", next)),
    ).toBe("2026-03-09T06:30:00.000Z");
  });

  it("fires once on a DST fall-back day, when the local hour happens twice", () => {
    // America/New_York 2026-11-01: 01:00 occurs twice. Fire on the first one only.
    const next = computeNextDueAt(
      { kind: "daily", hour: 1, minute: 30 },
      "America/New_York",
      at("2026-10-31T12:00:00Z"),
    );
    expect(iso(next)).toBe("2026-11-01T05:30:00.000Z"); // 01:30 EDT, the first pass
    expect(
      iso(computeNextDueAt({ kind: "daily", hour: 1, minute: 30 }, "America/New_York", next)),
    ).toBe(
      "2026-11-02T06:30:00.000Z", // 01:30 EST, next day — not the second 01:30
    );
  });

  it("evaluates a raw cron expression in the same code path", () => {
    const next = computeNextDueAt(
      { kind: "cron", expr: "0 8 * * 1-5" },
      "Asia/Singapore",
      at("2026-07-11T00:00:00Z"),
    );
    expect(iso(next)).toBe("2026-07-13T00:00:00.000Z");
  });
});

describe("parseSchedule", () => {
  it("round-trips each preset", () => {
    expect(parseSchedule('{"kind":"weekly","weekday":1,"hour":8,"minute":0}')).toEqual({
      kind: "weekly",
      weekday: 1,
      hour: 8,
      minute: 0,
    });
  });

  it("rejects malformed JSON", () => {
    expect(() => parseSchedule("not json")).toThrow(/invalid schedule/i);
  });

  it("rejects an unknown kind", () => {
    expect(() => parseSchedule('{"kind":"fortnightly"}')).toThrow(/invalid schedule/i);
  });

  it("rejects an out-of-range hour", () => {
    expect(() => parseSchedule('{"kind":"daily","hour":24,"minute":0}')).toThrow(
      /invalid schedule/i,
    );
  });

  it("rejects a cron expression that does not parse", () => {
    expect(() => parseSchedule('{"kind":"cron","expr":"not a cron"}')).toThrow(/invalid schedule/i);
  });
});

describe("isValidTimezone", () => {
  it("accepts an IANA zone and rejects nonsense", () => {
    expect(isValidTimezone("Asia/Singapore")).toBe(true);
    expect(isValidTimezone("Mars/Olympus")).toBe(false);
  });
});

describe("describeSchedule", () => {
  it("renders a human summary for the list row", () => {
    expect(describeSchedule({ kind: "weekdays", hour: 8, minute: 0 })).toBe("Weekdays at 08:00");
    expect(describeSchedule({ kind: "daily", hour: 8, minute: 5 })).toBe("Daily at 08:05");
    expect(describeSchedule({ kind: "hourly", minute: 0 })).toBe("Hourly at :00");
    expect(describeSchedule({ kind: "weekly", weekday: 1, hour: 8, minute: 0 })).toBe(
      "Mondays at 08:00",
    );
    expect(describeSchedule({ kind: "cron", expr: "0 8 * * 1-5" })).toBe("Custom (0 8 * * 1-5)");
  });
});
