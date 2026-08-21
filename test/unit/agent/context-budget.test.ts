import { describe, expect, it } from "vitest";
import {
  boundingOptionsFor,
  CHARS_PER_TOKEN,
  resolveContextBudget,
} from "../../../src/agent/context-budget";

/** Every term the pipeline actually enforces. Mirrors `assertConverges`. */
const enforcedFloor = (b: ReturnType<typeof resolveContextBudget>): number =>
  b.headMaxChars / CHARS_PER_TOKEN +
  Math.max(b.tailTokenBudget, (b.minTailMessages * b.maxRetainedMessageChars) / CHARS_PER_TOKEN) +
  b.maxSummaryTokens +
  b.systemPromptReserveTokens;

describe("resolveContextBudget", () => {
  // The exact numbers the rewrite spec commits to for gpt-5.6-luna.
  it("derives the documented budget at a 272k window", () => {
    const b = resolveContextBudget(272_000);
    expect(b.inputBudgetTokens).toBe(212_800);
    expect(b.compactAfterTokens).toBe(196_416);
    expect(b.headMaxChars).toBe(16_384);
    expect(b.tailTokenBudget).toBe(43_520);
    expect(b.maxSummaryTokens).toBe(8_192);
    expect(b.partHeadChars).toBe(4_096);
    expect(b.partTailChars).toBe(1_024);
    expect(b.maxRetainedMessageChars).toBe(65_536);
    expect(b.maxToolOutputCapChars).toBe(32_768);
  });

  // The old assertion modelled a term the code did not enforce: the head as
  // `protectHead * maxToolOutputChars`, one truncated tool output per protected
  // message. The real head on thr_ba1be632 was 5.9x that. Every term here is
  // now enforced — by `boundTranscript` or by range selection.
  it("keeps the enforced floor far under the trigger at 272k", () => {
    const b = resolveContextBudget(272_000);
    expect(enforcedFloor(b)).toBe(59_808);
    expect(enforcedFloor(b)).toBeLessThan(b.compactAfterTokens * 0.35);
  });

  it.each([8_000, 16_000, 32_000, 128_000, 200_000, 272_000, 400_000, 1_000_000])(
    "stays convergent at a %i window",
    (window) => {
      const b = resolveContextBudget(window);
      expect(b.systemPromptReserveTokens).toBeGreaterThan(0);
      expect(enforcedFloor(b)).toBeLessThan(b.compactAfterTokens);
    },
  );

  it("triggers later than the old 0.8-of-input-budget rule", () => {
    const b = resolveContextBudget(272_000);
    expect(b.compactAfterTokens).toBeGreaterThan(Math.floor(b.inputBudgetTokens * 0.8));
  });

  it("trips the proactive guard later than the append threshold", () => {
    const b = resolveContextBudget(200_000);
    expect(b.proactiveInputTokens).toBeGreaterThan(b.compactAfterTokens);
    expect(b.proactiveInputTokens).toBeLessThan(b.inputBudgetTokens);
  });

  // `maxRetainedMessageChars` is clamped so `minTailMessages` retained messages
  // can never outgrow the tail budget. Without the clamp the tail term is
  // assumed rather than proved — the mistake the head term made.
  it("clamps the retained-message ceiling so the tail term is provable", () => {
    for (const window of [8_000, 32_000, 272_000, 1_000_000]) {
      const b = resolveContextBudget(window);
      expect((b.minTailMessages * b.maxRetainedMessageChars) / CHARS_PER_TOKEN).toBeLessThanOrEqual(
        b.tailTokenBudget,
      );
    }
  });

  it("reserves room for the system prompt, scaled down only where the window cannot afford it", () => {
    expect(resolveContextBudget(200_000).systemPromptReserveTokens).toBe(4_000);
    expect(resolveContextBudget(1_000_000).systemPromptReserveTokens).toBe(4_000);
    const tiny = resolveContextBudget(8_000);
    expect(tiny.systemPromptReserveTokens).toBeLessThan(4_000);
    expect(tiny.systemPromptReserveTokens).toBeGreaterThan(0);
  });

  // Every term now scales with the window, so a tiny window converges
  // arithmetically. The guard that remains is about usefulness, not arithmetic.
  it("rejects a window too small to summarize anything useful", () => {
    expect(() => resolveContextBudget(1_000)).toThrow(/too small to compact within/i);
    expect(() => resolveContextBudget(1_000)).toThrow(/summary budget/i);
  });

  it("keeps the proactive guard strictly between the trigger and the budget", () => {
    for (const window of [8_000, 32_000, 200_000, 272_000, 1_000_000]) {
      const b = resolveContextBudget(window);
      expect(b.proactiveInputTokens).toBeGreaterThan(b.compactAfterTokens);
      expect(b.proactiveInputTokens).toBeLessThan(b.inputBudgetTokens);
    }
  });

  it("no longer exposes the message-counted head or the recency window", () => {
    const b = resolveContextBudget(272_000) as unknown as Record<string, unknown>;
    expect(b.protectHead).toBeUndefined();
    expect(b.keepRecent).toBeUndefined();
    expect(b.maxToolOutputChars).toBeUndefined();
    expect(b.maxTextChars).toBeUndefined();
  });
});

describe("boundingOptionsFor", () => {
  it("projects exactly the fields the bounding module needs", () => {
    expect(boundingOptionsFor(resolveContextBudget(272_000))).toEqual({
      partHeadChars: 4_096,
      partTailChars: 1_024,
      minTailMessages: 2,
      maxRetainedMessageChars: 65_536,
      headMaxChars: 16_384,
    });
  });
});
