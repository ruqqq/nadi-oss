import {
  estimateMessageTokens,
  estimateStringTokens,
  truncateOlderMessages,
} from "agents/experimental/memory/utils";
import type { ContextBudget } from "./context-budget";
import { truncationOptionsFor } from "./context-budget";

/**
 * Message-history helpers that keep Think auto-compaction from thrashing.
 *
 * Background: Think's auto-compaction fires when an estimated token count
 * exceeds a threshold, but compaction only summarizes the *middle* of the
 * transcript — the head and recent tail are protected. When a few messages
 * carry huge tool outputs, an estimate that counts the raw stored history stays
 * above the threshold even though the protected mass is un-compressible, so
 * compaction fires every turn and never shortens anything.
 *
 * This closes that loop by counting tool outputs at the SAME truncated size the
 * model actually receives, so the trigger reflects the real payload.
 */

type ThreadMessages = Parameters<typeof estimateMessageTokens>[0];

/**
 * Token counter for `Session.compactAfter(threshold, { tokenCounter })`.
 *
 * Counts the transcript at EXACTLY the truncation the model-facing assembly
 * applies (see ThinkThreadAgent._assembleModelMessages), so the trigger measures
 * the real payload rather than the raw stored size. Counting raw stored bytes is
 * what made compaction fire every turn and never shorten anything.
 */
export function estimateTruncatedThreadTokens(input: {
  messages: ThreadMessages;
  systemPrompt: string;
  budget: ContextBudget;
}): number {
  return (
    estimateMessageTokens(
      truncateOlderMessages(input.messages, truncationOptionsFor(input.budget)),
    ) + estimateStringTokens(input.systemPrompt)
  );
}
