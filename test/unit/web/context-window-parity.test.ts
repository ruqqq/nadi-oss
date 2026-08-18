import { describe, expect, it } from "vitest";
import { resolveContextBudget } from "../../../src/agent/context-budget";
import {
  compactionTriggerTokens,
  willCompactOnSwitch,
} from "../../../web/src/lib/context-window";

/**
 * `web/src/lib/context-window.ts` hand-duplicates the compaction trigger from
 * `src/agent/context-budget.ts` (web/ cannot import src/ — see the model-switch
 * parity test for the same constraint). If the server retunes the trigger and
 * the copy drifts, the picker silently goes back to warning at the wrong
 * threshold with every other test still green.
 */
describe("compaction-trigger parity", () => {
  it("matches resolveContextBudget across the window range", () => {
    for (const window of [8_000, 32_000, 128_000, 200_000, 400_000, 1_000_000]) {
      expect(compactionTriggerTokens(window)).toBe(resolveContextBudget(window).compactAfterTokens);
    }
  });

  it("warns on the mainline case the raw-window comparison missed", () => {
    // 128k window, 100k of conversation: the window is bigger than the usage,
    // so the old `contextLength < currentUsageTokens` test said nothing — but
    // the trigger sits at 71,680 and the very next send compacts.
    expect(compactionTriggerTokens(128_000)).toBe(71_680);
    expect(willCompactOnSwitch(128_000, 100_000)).toBe(true);
    expect(128_000 < 100_000).toBe(false);
  });

  it("stays quiet for a genuinely roomy model and for an unknown window", () => {
    expect(willCompactOnSwitch(1_000_000, 100_000)).toBe(false);
    expect(willCompactOnSwitch(undefined, 100_000)).toBe(false);
    expect(willCompactOnSwitch(128_000, null)).toBe(false);
  });
});
