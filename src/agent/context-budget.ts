/**
 * Every context decision in a thread derives from one number: the model's
 * context window. Truncation, the compaction trigger, the write-time tool-output
 * cap, and the overflow guards all read this budget, so they can never disagree
 * with each other the way three independently-tuned constants did.
 */

/** The SDK's token estimator assumes ~4 chars/token; we mirror it so our
 * char-denominated caps and its token-denominated estimates line up. */
export const CHARS_PER_TOKEN = 4;

/** Used when the model's real window is unknown. Deliberately conservative: a
 * too-small guess compacts early (mild quality cost), a too-large one overflows
 * the provider (hard failure). */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

export type ContextBudget = {
  contextWindow: number;
  inputBudgetTokens: number;
  compactAfterTokens: number;
  proactiveInputTokens: number;
  keepRecent: number;
  maxToolOutputChars: number;
  maxTextChars: number;
  protectHead: number;
  tailTokenBudget: number;
  minTailMessages: number;
  maxSummaryTokens: number;
  maxToolOutputCapChars: number;
  systemPromptReserveTokens: number;
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(Math.floor(value), min), max);

export function resolveContextBudget(contextWindow: number): ContextBudget {
  // Reserve room for the model's own output plus a safety margin — the token
  // estimate is a heuristic, so we never plan to fill the window exactly.
  const reservedOutput = Math.min(32_000, contextWindow * 0.2);
  const inputBudgetTokens = Math.floor(contextWindow - reservedOutput - contextWindow * 0.1);

  const compactAfterTokens = Math.floor(inputBudgetTokens * 0.8);
  const proactiveInputTokens = Math.floor(inputBudgetTokens * 0.9);
  const inputBudgetChars = inputBudgetTokens * CHARS_PER_TOKEN;

  const keepRecent = clamp(inputBudgetTokens / 10_000, 4, 32);
  const maxToolOutputChars = clamp(inputBudgetChars * 0.02, 500, 20_000);
  const maxTextChars = clamp(inputBudgetChars * 0.05, 10_000, 100_000);

  const protectHead = 3;
  const minTailMessages = 2;
  const tailTokenBudget = Math.floor(compactAfterTokens * 0.25);
  const maxSummaryTokens = Math.floor(compactAfterTokens * 0.1);

  // The protected tail is replayed at full fidelity, so a single pathological
  // tool result would otherwise pin the floor above the trigger — which is
  // exactly how the tool-heavy runaway happened. Scaling the WRITE-time cap to
  // the window is what bounds it.
  //
  // 10% is not arbitrary: `minTailMessages` outputs at this cap cost
  // `2 * 0.10 * inputBudgetTokens` tokens, which is exactly `tailTokenBudget`
  // (25% of the 80% trigger = 20% of the input budget). At any larger fraction
  // the write-time cap — not the tail budget — dictates the protected tail, and
  // the floor grows without a compensating rise in the trigger. 10% is the
  // largest cap at which the tail budget stays the binding constraint.
  const maxToolOutputCapChars = Math.floor(inputBudgetChars * 0.1);

  // The compaction trigger is compared against an estimate that INCLUDES the
  // system prompt (see estimateTruncatedThreadTokens), but the protected floor
  // is messages-only — so the real message budget is `compactAfterTokens` minus
  // the system prompt. Nadi's system prompt is soul + a memory block capped at
  // 2k tokens + role + skills: realistically 1k-4k tokens, which is invisible at
  // a 200k window and larger than the entire headroom at 8k. A flat 4k reserve
  // would make an 8k window uncompactable, so it scales down with the budget.
  const systemPromptReserveTokens = Math.min(4_000, Math.floor(inputBudgetTokens * 0.25));

  const budget: ContextBudget = {
    contextWindow,
    inputBudgetTokens,
    compactAfterTokens,
    proactiveInputTokens,
    keepRecent,
    maxToolOutputChars,
    maxTextChars,
    protectHead,
    tailTokenBudget,
    minTailMessages,
    maxSummaryTokens,
    maxToolOutputCapChars,
    systemPromptReserveTokens,
  };

  assertConverges(budget);
  return budget;
}

/** The exact options Think's `truncateOlderMessages` takes, derived from the
 * budget. Shared by the model-facing assembly and the compaction token counter
 * so the trigger measures precisely what the model is sent. */
export function truncationOptionsFor(budget: ContextBudget): {
  keepRecent: number;
  maxToolOutputChars: number;
  maxTextChars: number;
} {
  return {
    keepRecent: budget.keepRecent,
    maxToolOutputChars: budget.maxToolOutputChars,
    maxTextChars: budget.maxTextChars,
  };
}

/**
 * Compaction can only summarize the MIDDLE of the transcript. If the parts it
 * cannot touch — the protected head, the protected tail, the summary it writes,
 * and the system prompt that is measured against the same trigger — already
 * exceed the trigger, compaction fires on every append and never shortens
 * anything. That is not a tuning wart; it is an unrecoverable loop. Assert it
 * away at construction so a future tuning change fails loudly here instead of
 * silently re-creating the runaway in production.
 */
function assertConverges(b: ContextBudget): void {
  const headTokens = b.protectHead * (b.maxToolOutputChars / CHARS_PER_TOKEN);
  const tailTokens = Math.max(
    b.tailTokenBudget,
    b.minTailMessages * (b.maxToolOutputCapChars / CHARS_PER_TOKEN),
  );
  // The system prompt belongs in the floor because the trigger is compared
  // against a total that includes it, while none of compaction's levers can
  // shrink it.
  const floor = headTokens + tailTokens + b.maxSummaryTokens + b.systemPromptReserveTokens;
  if (floor >= b.compactAfterTokens) {
    throw new Error(
      `Context window ${b.contextWindow} yields a non-convergent compaction budget: ` +
        `protected floor ${Math.ceil(floor)} (incl. ${b.systemPromptReserveTokens} system-prompt ` +
        `reserve) >= trigger ${b.compactAfterTokens}. ` +
        `Compaction would fire every turn and never shorten history.`,
    );
  }
}
