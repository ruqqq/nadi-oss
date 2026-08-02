import { describe, expect, it } from "vitest";
import {
  parseDateInterval,
  timestampInInterval,
} from "../../../src/thread-knowledge/date-interval";

describe("parseDateInterval", () => {
  it("uses inclusive since and exclusive until", () => {
    const interval = parseDateInterval({
      since: "2026-07-01T00:00:00.000Z",
      until: "2026-07-08T00:00:00.000Z",
    });
    expect(interval).toEqual({
      since: Date.parse("2026-07-01T00:00:00.000Z"),
      until: Date.parse("2026-07-08T00:00:00.000Z"),
    });
    expect(timestampInInterval(interval.since, interval)).toBe(true);
    expect(timestampInInterval(interval.until, interval)).toBe(false);
  });

  it("rejects invalid and reversed intervals", () => {
    expect(() => parseDateInterval({ since: "not-a-date" })).toThrow("invalid_since");
    expect(() =>
      parseDateInterval({
        since: "2026-07-08T00:00:00.000Z",
        until: "2026-07-01T00:00:00.000Z",
      }),
    ).toThrow("invalid_interval");
  });

  it("omits undated messages only when a bound is present", () => {
    expect(timestampInInterval(null, {})).toBe(true);
    expect(timestampInInterval(null, { since: 1 })).toBe(false);
  });
});
