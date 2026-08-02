import { describe, expect, it } from "vitest";
import { formatContextGauge } from "./context-gauge";

describe("formatContextGauge", () => {
  it("returns null when untracked — the caller must render 'Not tracked', never 0", () => {
    expect(formatContextGauge(null, 200_000)).toBeNull();
    expect(formatContextGauge(48_000, null)).toBeNull();
    expect(formatContextGauge(null, null)).toBeNull();
  });

  it("formats tokens against the window with a percentage", () => {
    expect(formatContextGauge(48_000, 200_000, 118_400)).toEqual({
      label: "48k / 200k · 24%",
      percent: 24,
      tone: "normal",
    });
  });

  // The trigger is ~59% of a 200k window, not 80% of it. Warning off the window
  // would make the amber tone unreachable: the thread compacts ~42k earlier.
  it("warns at the REAL compaction trigger the server recorded, not a fraction of the window", () => {
    expect(formatContextGauge(118_400, 200_000, 118_400)?.tone).toBe("warning");
    expect(formatContextGauge(115_000, 200_000, 118_400)?.tone).toBe("normal");
    // Would be "normal" under the old window-relative rule (59% < 80%).
    expect(formatContextGauge(120_000, 200_000, 118_400)?.tone).toBe("warning");
  });

  it("warns at nothing when the server recorded no trigger — never invents one", () => {
    expect(formatContextGauge(170_000, 200_000, null)?.tone).toBe("normal");
    expect(formatContextGauge(170_000, 200_000)?.tone).toBe("normal");
    expect(formatContextGauge(170_000, 200_000, 0)?.tone).toBe("normal");
  });

  it("clamps a context that somehow exceeds the window rather than rendering >100%", () => {
    const gauge = formatContextGauge(250_000, 200_000, 118_400)!;
    expect(gauge.percent).toBe(100);
    expect(gauge.tone).toBe("warning");
  });

  it("renders small counts exactly rather than as '0k'", () => {
    expect(formatContextGauge(320, 200_000)?.label).toBe("320 / 200k · 0%");
  });

  it("does not divide by zero", () => {
    expect(formatContextGauge(1_000, 0)).toBeNull();
  });
});
