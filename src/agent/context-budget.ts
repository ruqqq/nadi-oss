/**
 * Every context decision in a thread derives from one number: the model's
 * context window. Truncation, the compaction trigger, the write-time tool-output
 * cap, and the overflow guards all read this budget, so they can never disagree
 * with each other the way three independently-tuned constants did.
 */

import type { BoundingOptions } from "./transcript-bounding";

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
  /** Hard ceiling on the first user message — the only message compaction never
   *  summarizes, so the only one whose whole size must be capped outright. */
  headMaxChars: number;
  tailTokenBudget: number;
  minTailMessages: number;
  maxSummaryTokens: number;
  partHeadChars: number;
  partTailChars: number;
  maxRetainedMessageChars: number;
  maxToolOutputCapChars: number;
  systemPromptReserveTokens: number;
  compactionRetries: number;
};

/** pi's `reserveTokens`: how far below the input budget compaction fires. A
 *  later trigger means fewer compactions, and each one is a lossy generation. */
const LATE_RESERVE_TOKENS = 16_384;
/** deepseek's `retainRatio`. */
const RETAIN_RATIO = 0.16;
/** Absolute, never a fraction of the window: a fraction makes the permanent
 *  floor grow with the model, which is backwards. opencode 4096; deepseek and
 *  buzz 8192. */
const MAX_SUMMARY_TOKENS = 8_192;
const PART_HEAD_CHARS = 4_096;
const PART_TAIL_CHARS = 1_024;
/** buzz's HANDOFF_ORIGINAL_TASK_MAX_BYTES. */
const HEAD_MAX_CHARS = 16_384;
const MAX_RETAINED_MESSAGE_CHARS = 65_536;
const WRITE_CAP_CHARS = 32_768;
const COMPACTION_RETRIES = 1;
/** Below this a summary cannot carry a thread's state, so compaction is
 *  theatre: it converges arithmetically and loses everything. deepseek warns
 *  that too-small thresholds cause compaction loops; Anthropic's compact API
 *  refuses thresholds under 50k for the same reason. */
const MIN_USEFUL_SUMMARY_TOKENS = 256;

export function resolveContextBudget(contextWindow: number): ContextBudget {
  // Reserve room for the model's own output plus a safety margin — the token
  // estimate is a heuristic, so we never plan to fill the window exactly.
  const reservedOutput = Math.min(32_000, contextWindow * 0.2);
  const inputBudgetTokens = Math.floor(contextWindow - reservedOutput - contextWindow * 0.1);

  // Scaled down on small windows so an 8k model still has headroom.
  const lateReserve = Math.min(LATE_RESERVE_TOKENS, Math.floor(inputBudgetTokens * 0.1));
  const compactAfterTokens = inputBudgetTokens - lateReserve;
  // Must sit strictly BETWEEN the append trigger and the input budget. It used
  // to be a flat 0.9 of the budget, which collides with the late trigger the
  // moment `lateReserve` clamps to 10% — at a 200k window both landed on
  // 133,200 and the proactive guard stopped being a second line of defence.
  const proactiveInputTokens =
    compactAfterTokens + Math.floor((inputBudgetTokens - compactAfterTokens) / 2);
  const inputBudgetChars = inputBudgetTokens * CHARS_PER_TOKEN;

  const minTailMessages = 2;
  const tailTokenBudget = Math.floor(contextWindow * RETAIN_RATIO);
  const headMaxChars = Math.min(HEAD_MAX_CHARS, Math.floor(inputBudgetChars * 0.05));
  const maxSummaryTokens = Math.min(MAX_SUMMARY_TOKENS, Math.floor(compactAfterTokens * 0.1));

  // Clamped so `minTailMessages` retained messages can never exceed the tail
  // budget. This is what makes the floor's tail term provable rather than
  // assumed — the mistake the old assertion made about the head.
  const maxRetainedMessageChars = Math.min(
    MAX_RETAINED_MESSAGE_CHARS,
    Math.floor((tailTokenBudget * CHARS_PER_TOKEN) / minTailMessages),
  );
  const maxToolOutputCapChars = Math.min(WRITE_CAP_CHARS, maxRetainedMessageChars);
  const systemPromptReserveTokens = Math.min(4_000, Math.floor(inputBudgetTokens * 0.25));

  const budget: ContextBudget = {
    contextWindow,
    inputBudgetTokens,
    compactAfterTokens,
    proactiveInputTokens,
    headMaxChars,
    tailTokenBudget,
    minTailMessages,
    maxSummaryTokens,
    partHeadChars: PART_HEAD_CHARS,
    partTailChars: PART_TAIL_CHARS,
    maxRetainedMessageChars,
    maxToolOutputCapChars,
    systemPromptReserveTokens,
    compactionRetries: COMPACTION_RETRIES,
  };
  assertConverges(budget);
  return budget;
}

/** Project the budget onto exactly what `boundTranscript` needs. Both the
 *  model-facing assembly and the compaction trigger go through this, so the
 *  trigger can never measure a different transcript than the one we send. */
export function boundingOptionsFor(budget: ContextBudget): BoundingOptions {
  return {
    partHeadChars: budget.partHeadChars,
    partTailChars: budget.partTailChars,
    minTailMessages: budget.minTailMessages,
    maxRetainedMessageChars: budget.maxRetainedMessageChars,
    headMaxChars: budget.headMaxChars,
  };
}

/**
 * Compaction can only summarize the middle. If the parts it cannot touch
 * already exceed the trigger, it fires on every append and shortens nothing.
 *
 * The previous version asserted over `protectHead * maxToolOutputChars` — one
 * truncated tool output per protected message. Cost is per PART, and a single
 * assistant turn was measured at 23 tool calls and 75,283 tokens: 5.9x the
 * asserted head. The assertion passed at construction and was false at runtime.
 * Every term here is one the pipeline enforces.
 */
function assertConverges(b: ContextBudget): void {
  if (b.maxSummaryTokens < MIN_USEFUL_SUMMARY_TOKENS) {
    throw new Error(
      `Context window ${b.contextWindow} is too small to compact within: summary budget ` +
        `${b.maxSummaryTokens} < ${MIN_USEFUL_SUMMARY_TOKENS} tokens. Every budget term scales ` +
        `with the window, so this converges arithmetically while summarizing nothing useful.`,
    );
  }
  const headTokens = b.headMaxChars / CHARS_PER_TOKEN;
  // `maxRetainedMessageChars` is clamped so this can never exceed the budget.
  const tailTokens = Math.max(
    b.tailTokenBudget,
    (b.minTailMessages * b.maxRetainedMessageChars) / CHARS_PER_TOKEN,
  );
  const floor = headTokens + tailTokens + b.maxSummaryTokens + b.systemPromptReserveTokens;
  if (floor >= b.compactAfterTokens) {
    throw new Error(
      `Context window ${b.contextWindow} yields a non-convergent compaction budget: ` +
        `enforced floor ${Math.ceil(floor)} (incl. ${b.systemPromptReserveTokens} system-prompt ` +
        `reserve) >= trigger ${b.compactAfterTokens}. ` +
        `Compaction would fire every turn and never shorten history.`,
    );
  }
}
