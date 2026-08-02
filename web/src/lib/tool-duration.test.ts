import { describe, expect, it } from "vitest";
import { formatToolDuration, getToolDurationMs } from "./tool-duration";

describe("getToolDurationMs", () => {
  it("reads a stamped duration off a part", () => {
    expect(getToolDurationMs({ durationMs: 2_600 })).toBe(2_600);
    expect(getToolDurationMs({ durationMs: 0 })).toBe(0);
  });

  // Parts written before the feature carry nothing. That is normal and must
  // render as nothing, not as an error or a zero.
  it("returns undefined for a part with no duration", () => {
    expect(getToolDurationMs({})).toBeUndefined();
    expect(getToolDurationMs(undefined)).toBeUndefined();
  });

  it("rejects values that are not usable durations", () => {
    expect(getToolDurationMs({ durationMs: "2600" })).toBeUndefined();
    expect(getToolDurationMs({ durationMs: -1 })).toBeUndefined();
    expect(getToolDurationMs({ durationMs: Number.NaN })).toBeUndefined();
    expect(getToolDurationMs({ durationMs: Number.POSITIVE_INFINITY })).toBeUndefined();
  });
});

describe("formatToolDuration", () => {
  // Every call has latency; labelling the fast ones adds a number to every row
  // and buys nothing. The point is to make a SLOW call obvious.
  it("shows nothing under a second", () => {
    expect(formatToolDuration(0)).toBeUndefined();
    expect(formatToolDuration(999)).toBeUndefined();
    expect(formatToolDuration(undefined)).toBeUndefined();
  });

  it("shows one decimal under ten seconds", () => {
    expect(formatToolDuration(1_000)).toBe("1.0s");
    expect(formatToolDuration(2_615)).toBe("2.6s");
  });

  it("shows whole seconds under a minute", () => {
    expect(formatToolDuration(10_000)).toBe("10s");
    expect(formatToolDuration(59_400)).toBe("59s");
  });

  it("shows minutes and seconds", () => {
    expect(formatToolDuration(60_000)).toBe("1m");
    expect(formatToolDuration(252_000)).toBe("4m 12s");
    // The measured orphan-pipe case.
    expect(formatToolDuration(123_000)).toBe("2m 3s");
  });

  it("shows hours and minutes", () => {
    expect(formatToolDuration(3_600_000)).toBe("1h");
    expect(formatToolDuration(3_780_000)).toBe("1h 3m");
  });
});
