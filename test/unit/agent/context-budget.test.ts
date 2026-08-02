import { describe, expect, it } from "vitest";
import { CHARS_PER_TOKEN, resolveContextBudget } from "../../../src/agent/context-budget";

describe("resolveContextBudget", () => {
  it("scales truncation to the window instead of the SDK's fixed 4/500", () => {
    const small = resolveContextBudget(32_000);
    const large = resolveContextBudget(200_000);

    // The SDK hardcodes keepRecent: 4, maxToolOutputChars: 500 for every model.
    expect(large.keepRecent).toBeGreaterThan(small.keepRecent);
    expect(large.maxToolOutputChars).toBeGreaterThan(small.maxToolOutputChars);
    expect(large.maxToolOutputChars).toBeGreaterThan(500);
  });

  it("keeps a small model at SDK parity floors", () => {
    const tiny = resolveContextBudget(8_000);
    expect(tiny.keepRecent).toBe(4);
    expect(tiny.maxToolOutputChars).toBe(500);
  });

  it("trips the proactive guard later than the append threshold", () => {
    const budget = resolveContextBudget(200_000);
    expect(budget.proactiveInputTokens).toBeGreaterThan(budget.compactAfterTokens);
    expect(budget.proactiveInputTokens).toBeLessThan(budget.inputBudgetTokens);
  });

  // The runaway, encoded. Compaction can only summarize the MIDDLE; if the
  // protected head + protected tail + summary + the system prompt already exceed
  // the trigger, it fires on every append and never shortens anything. This is
  // the regression that the stored-history strip pass was originally bolted on
  // to mask.
  it.each([8_000, 16_000, 32_000, 128_000, 200_000, 400_000, 1_000_000])(
    "guarantees the protected floor fits under the trigger at a %i window",
    (window) => {
      const b = resolveContextBudget(window);
      const headTokens = b.protectHead * (b.maxToolOutputChars / CHARS_PER_TOKEN);
      // Tail messages are inside keepRecent, so they are replayed at FULL
      // fidelity — their size is bounded only by the write-time cap.
      const tailTokens = Math.max(
        b.tailTokenBudget,
        b.minTailMessages * (b.maxToolOutputCapChars / CHARS_PER_TOKEN),
      );
      // The trigger is compared against a total that INCLUDES the system prompt
      // (estimateTruncatedThreadTokens adds it), and compaction cannot shrink
      // it — so it is part of the floor, not free headroom.
      expect(b.systemPromptReserveTokens).toBeGreaterThan(0);
      const floor = headTokens + tailTokens + b.maxSummaryTokens + b.systemPromptReserveTokens;
      expect(floor).toBeLessThan(b.compactAfterTokens);
    },
  );

  // A reserve that never binds is not a reserve: it must be big enough to cover
  // a real system prompt (soul + a 2k-token memory block + role + skills) once
  // the window is large enough to afford one.
  it("reserves room for the system prompt, scaled down only where the window cannot afford it", () => {
    expect(resolveContextBudget(200_000).systemPromptReserveTokens).toBe(4_000);
    expect(resolveContextBudget(1_000_000).systemPromptReserveTokens).toBe(4_000);
    const tiny = resolveContextBudget(8_000);
    expect(tiny.systemPromptReserveTokens).toBeLessThan(4_000);
    expect(tiny.systemPromptReserveTokens).toBeGreaterThan(0);
  });

  it("rejects a window too small to compact within", () => {
    expect(() => resolveContextBudget(1_000)).toThrow(/context window/i);
  });
});
