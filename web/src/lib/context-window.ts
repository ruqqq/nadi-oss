/**
 * When a model swap will compact the conversation.
 *
 * The picker used to compare a candidate's raw context window against the
 * thread's current usage, which is the wrong threshold: nothing waits until a
 * thread FILLS the window. `resolveContextBudget` reserves output room and a
 * safety margin and then triggers compaction at 80% of what is left — about
 * 56% of the window — so a 100k-token thread moving to a 128k model (window
 * 128k > usage 100k, no warning) compacted on the very next send.
 *
 * Mirrors `src/agent/context-budget.ts`'s `compactAfterTokens` derivation.
 * `web/` is a separate package whose tsconfig cannot reach `src/`, the same
 * reason `web/src/lib/model-switch.ts` is a hand copy — and the same reason
 * `test/unit/web/context-window-parity.test.ts` exists to pin the two
 * together.
 */
export function compactionTriggerTokens(contextWindow: number): number {
  const reservedOutput = Math.min(32_000, contextWindow * 0.2);
  const inputBudgetTokens = Math.floor(contextWindow - reservedOutput - contextWindow * 0.1);
  return Math.floor(inputBudgetTokens * 0.8);
}

/**
 * Only a KNOWN window that the conversation would already push past its
 * compaction trigger earns the warning. An absent `contextLength` (uncurated
 * provider, catalog miss) is unknown, not "too small".
 */
export function willCompactOnSwitch(
  contextLength: number | null | undefined,
  currentUsageTokens: number | null | undefined,
): boolean {
  if (typeof currentUsageTokens !== "number" || typeof contextLength !== "number") return false;
  return compactionTriggerTokens(contextLength) < currentUsageTokens;
}
