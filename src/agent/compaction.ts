/**
 * Nadi's own compaction function, replacing the SDK's `createCompactFunction`.
 *
 * The SDK's version has two bugs we cannot fix from outside, plus a missing
 * bound: its summary prompt stringifies tool outputs with `String(output)` (so
 * every object-shaped Nadi tool output reads as "[object Object]"), its summary
 * budget has no upper clamp, and its head/tail protection is fixed constants
 * rather than derived from the context budget.
 */
import {
  alignBoundaryBackward,
  alignBoundaryForward,
  estimateMessageTokens,
  isCompactionMessage,
} from "agents/experimental/memory/utils";
import { boundingOptionsFor, CHARS_PER_TOKEN, type ContextBudget } from "./context-budget";
import { boundText, boundTranscript, MARKER_MAX_CHARS } from "./transcript-bounding";

type ThreadMessages = Parameters<typeof estimateMessageTokens>[0];

/**
 * What the summarizer is asked for.
 *
 * `messages` are the span itself, bounded EXACTLY as the model-facing assembly
 * bounds them, so the provider sees a prefix it has already cached. Rendering
 * them into a bespoke string — which this used to do — shares no prefix with
 * the thread's own requests and misses the cache on every compaction, at ~196k
 * of input. deepseek replays the conversation's own messages for exactly this
 * reason and appends the instruction last.
 */
export type SummarizeRequest = {
  messages: ThreadMessages;
  instruction: string;
};

export type CompactionResult = {
  fromMessageId: string;
  toMessageId: string;
  summary: string;
  /** Set only by the last-resort reset, which discards the whole span between
   *  the head and the current prompt rather than a converging middle. */
  reset?: true;
};

export type CompactionOutcome =
  | { status: "shortened"; summarizedMessages: number; summaryTokens: number }
  | { status: "retried"; attempt: number; reason: string }
  | { status: "reset"; discardedMessages: number; reason: string }
  | { status: "noop"; reason: string }
  | { status: "failed"; error: string };
/**
 * Tool outputs are no longer rendered into a summarizer prompt: the span is sent
 * as MESSAGES (see `SummarizeRequest`), so the provider serializes them itself.
 * That retires `renderMessage` / `serializeToolOutputForSummary` and with them
 * the "[object Object]" class of bug they existed to prevent — the SDK's
 * `String(output)` path is no longer on the map at all.
 */

/** Collapse concurrent compaction attempts onto one run: a DO is
 * single-threaded but await points are not, so two turns can both observe the
 * over-threshold history and start a compaction. */
export function createInFlightGuard(): <T>(work: () => Promise<T>) => Promise<T> {
  let inFlight: Promise<unknown> | null = null;
  return async <T>(work: () => Promise<T>): Promise<T> => {
    if (inFlight) return inFlight as Promise<T>;
    const run = work().finally(() => {
      inFlight = null;
    });
    inFlight = run;
    return run;
  };
}

/**
 * deepseek's checkpoint preamble: name the checkpoint as settled context so the
 * model builds on it instead of narrating it back or re-deriving it.
 */
/** Must match `renderContinuity`'s heading in continuity-index.ts. */
const CONTINUITY_HEADING = "## Work already done";

const CHECKPOINT_PREAMBLE =
  "This is an automatically generated checkpoint condensing an earlier span of this thread to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.";

/**
 * The text the checkpoint actually carries: preamble, the COMPUTED continuity
 * block, then the model-written prose.
 *
 * The continuity block goes first and is not model-written, because a
 * summarizer under context pressure drops bookkeeping first — and bookkeeping
 * is what stops the next turn redoing finished work.
 */
export function buildCheckpointText(summary: string, continuityBlock: string): string {
  const blocks = [CHECKPOINT_PREAMBLE];
  if (continuityBlock.trim() !== "") blocks.push(continuityBlock.trim());
  blocks.push(stripCheckpointFraming(summary));
  return blocks.join("\n\n");
}

/**
 * Remove framing this module added on a previous cycle.
 *
 * The previous checkpoint is handed to the summarizer as the summary to UPDATE,
 * so it can echo the preamble and the continuity block back in its output.
 * Re-framing that verbatim stacks a second preamble on every compaction, and
 * the model reads the same instruction twice — the compounding-waste shape the
 * overlay-persistence bug already had once.
 */
export function stripCheckpointFraming(text: string): string {
  let out = text.trim();
  if (out.startsWith(CHECKPOINT_PREAMBLE)) out = out.slice(CHECKPOINT_PREAMBLE.length).trim();
  if (out.startsWith(CONTINUITY_HEADING)) {
    const nextBlock = out.indexOf("\n\n");
    out = nextBlock >= 0 ? out.slice(nextBlock).trim() : "";
  }
  return out;
}

/**
 * The protected head is the FIRST USER MESSAGE and nothing else.
 *
 * `protectHead = 3` protected three messages regardless of what they held; on
 * thr_ba1be632 the third was a single assistant turn of 23 tool calls, 96.7% of
 * the thread, permanently uncompactable. All four surveyed harnesses compact the
 * head; buzz alone preserves the original task, bounded, which is what this is.
 *
 * Size is not this function's job — `boundTranscript` enforces `headMaxChars` on
 * the way to the model. Here the head is a POSITION: the original task, kept so
 * a summarizer can never paraphrase it.
 */
export function buildInstruction(previousSummary: string | null, targetTokens: number): string {
  const structure = [
    "## Topic",
    "[What the conversation is about]",
    "",
    "## Key Points",
    "[Important information, decisions, and conclusions]",
    "",
    "## Current State",
    "[What has been done, what is in progress]",
    "",
    "## Open Items",
    "[Unresolved questions, pending tasks]",
    "",
    "## Next Action",
    "[State exactly one concrete next action — the single thing to do next, not a list]",
  ].join("\n");
  const tail = `Target ~${targetTokens} tokens. Be factual — only include information explicitly present above. Do NOT invent file paths, commands, or details. Write only the summary body.`;

  if (previousSummary) {
    return `Summarize the conversation above for future context. A previous summary exists; new turns have occurred since and need to be incorporated.\n\nPREVIOUS SUMMARY:\n${previousSummary}\n\nUpdate the summary. PRESERVE existing information that is still relevant. ADD new information. Remove information only if clearly obsolete.\n\n${structure}\n\n${tail}`;
  }
  return `Summarize the conversation above, preserving the important information for future context.\n\n${structure}\n\n${tail}`;
}

function selectHeadEnd(messages: ThreadMessages): number {
  const firstUser = messages.findIndex((m) => m.role === "user");
  if (firstUser < 0) return 0;
  return alignBoundaryForward(messages, firstUser + 1);
}

/** Walk backward from the leaf accumulating tokens until the tail budget is
 * spent; everything from the returned index onward is protected. */
function findTailCut(messages: ThreadMessages, headEnd: number, budget: ContextBudget): number {
  const n = messages.length;
  let accumulated = 0;
  let cut = n;
  for (let i = n - 1; i >= headEnd; i--) {
    const tokens = estimateMessageTokens([messages[i]] as ThreadMessages);
    if (accumulated + tokens > budget.tailTokenBudget && cut < n) break;
    accumulated += tokens;
    cut = i;
  }
  const minCut = n - budget.minTailMessages;
  return alignBoundaryBackward(messages, minCut >= headEnd ? Math.min(cut, minCut) : cut);
}

/**
 * The last rung: discard everything between the head and the current prompt.
 *
 * Modelled on buzz's `handoff.rs`, which clears history and re-pushes the
 * summary plus the current prompt — a shape that also cannot orphan a tool
 * result, because the assistant turns that owned them are gone.
 *
 * It bounds its own summary rather than validating it. Every other rung may
 * decline; this one runs precisely when they all did, so it has to succeed, and
 * an unbounded checkpoint here would recreate the floor it exists to collapse.
 */
function reset(
  messages: ThreadMessages,
  start: number,
  summary: string,
  reason: string,
  budget: ContextBudget,
  continuityBlock: string,
  onOutcome: (outcome: CompactionOutcome) => void,
): CompactionResult | null {
  // The trailing user message is the prompt being answered right now; buzz
  // re-pushes it after the handoff for the same reason.
  const last = messages[messages.length - 1];
  const endExclusive = last?.role === "user" ? messages.length - 1 : messages.length;
  const span = messages.slice(start, endExclusive).filter((m) => !isCompactionMessage(m));
  const first = span[0];
  const lastSummarized = span[span.length - 1];
  if (!first || !lastSummarized) {
    onOutcome({ status: "failed", error: reason });
    return null;
  }
  // The WHOLE checkpoint must fit the summary budget, not just the prose: the
  // preamble and the continuity block are sent to the model too. Bound the
  // prose by what the framing leaves, minus the marker's own width, or the
  // reset overshoots the very floor it exists to collapse.
  const framingChars = buildCheckpointText("", continuityBlock).length;
  const bounded = boundText(
    summary,
    Math.max(1, budget.maxSummaryTokens * CHARS_PER_TOKEN - framingChars - MARKER_MAX_CHARS),
    0,
  );
  onOutcome({ status: "reset", discardedMessages: span.length, reason });
  return {
    fromMessageId: first.id,
    toMessageId: lastSummarized.id,
    // The reset retains NO tail, so it is the path that most needs the
    // computed continuity block — without it a reset guarantees a redo.
    summary: buildCheckpointText(bounded, continuityBlock),
    reset: true,
  };
}

export function createNadiCompactFunction(opts: {
  budget: ContextBudget;
  summarize: (request: SummarizeRequest) => Promise<string>;
  onOutcome: (outcome: CompactionOutcome) => void;
  /** Rendered continuity block (see continuity-index.ts), carried above the
   *  prose in every checkpoint this function produces. */
  continuityBlock?: string;
}) {
  const { budget, summarize, onOutcome } = opts;
  const continuityBlock = opts.continuityBlock ?? "";

  // The SDK hands this function a `context.tokenCounter` and we deliberately do
  // not take it: `findTailCut` uses the raw per-message estimator instead. The
  // raw estimator over-counts each message (the session counter accounts for
  // truncation), so it spends the tail budget sooner and protects FEWER
  // messages. That errs toward a smaller protected tail — the direction that
  // keeps the convergence invariant in `context-budget.ts` true. Swapping in the
  // session counter would grow the protected tail and could push the floor back
  // above the trigger.
  return async (messages: ThreadMessages): Promise<CompactionResult | null> => {
    if (messages.length <= 1 + budget.minTailMessages) {
      onOutcome({ status: "noop", reason: "history shorter than the protected span" });
      return null;
    }

    const start = selectHeadEnd(messages);
    const end = findTailCut(messages, start, budget);
    if (end <= start) {
      onOutcome({ status: "noop", reason: "nothing between the protected head and tail" });
      return null;
    }

    const existing = messages.find(isCompactionMessage);
    const previousSummary = existing
      ? stripCheckpointFraming(
          (existing.parts as unknown as { type: string; text?: string }[])
            .filter((p) => p.type === "text")
            .map((p) => p.text ?? "")
            .join("\n"),
        )
      : null;

    // Widen INTO the tail on each retry, halving the remaining distance and
    // never taking the last `minTailMessages`. A wider span is a bigger source,
    // so a summary that failed the shrink check against a small span can clear
    // it against a larger one — and it reclaims more, which is the point.
    const maxEnd = Math.max(start + 1, messages.length - budget.minTailMessages);
    let attemptEnd = end;

    for (let attempt = 0; attempt <= budget.compactionRetries; attempt++) {
      const middle = messages.slice(start, attemptEnd).filter((m) => !isCompactionMessage(m));
      const first = middle[0];
      const last = middle[middle.length - 1];
      if (!first || !last) {
        onOutcome({ status: "noop", reason: "middle is already compacted" });
        return null;
      }

      const spanTokens = estimateMessageTokens(middle);
      // The SDK asks for 20% of the compressed content with NO upper bound (its
      // docstring claims a 2K-8K clamp that the code does not implement), so a
      // large middle asks for an enormous summary — which then inflates the
      // post-compaction floor it is supposed to shrink.
      const targetTokens = Math.max(
        100,
        Math.min(Math.floor(spanTokens * 0.2), budget.maxSummaryTokens),
      );

      let summary: string;
      try {
        summary = await summarize({
          // Bounded with the ASSEMBLY's options, not tighter summarizer-only
          // ones: a differently-bounded prefix is a DIFFERENT prefix, and the
          // cache misses anyway. minTailMessages 0 because every message in
          // this span is outside the assembly's retained tail, and headMaxChars
          // is lifted because index 0 of the SPAN is not the thread's head.
          messages: boundTranscript(middle, {
            ...boundingOptionsFor(budget),
            minTailMessages: 0,
            headMaxChars: Number.MAX_SAFE_INTEGER,
          }) as ThreadMessages,
          instruction: buildInstruction(previousSummary, targetTokens),
        });
      } catch (error) {
        // A failed summarizer must NOT masquerade as "nothing to compact" —
        // which is exactly what the user saw, because Session.compact()
        // swallows the throw and returns null.
        onOutcome({
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }

      if (!summary.trim()) {
        onOutcome({ status: "failed", error: "summarizer returned an empty summary" });
        return null;
      }

      const summaryTokens = Math.ceil(summary.length / CHARS_PER_TOKEN);
      // Runtime convergence, replacing a construction-time assertion that
      // modelled a head shape the code never enforced. deepseek's rule: reject
      // a summary that does not shrink its source.
      const tooLarge =
        summaryTokens >= spanTokens
          ? "summary did not shrink its source"
          : summaryTokens > budget.maxSummaryTokens
            ? "summary exceeded the summary budget"
            : null;
      if (tooLarge) {
        if (attempt < budget.compactionRetries && attemptEnd < maxEnd) {
          attemptEnd = alignBoundaryForward(
            messages,
            Math.min(maxEnd, attemptEnd + Math.ceil((maxEnd - attemptEnd) / 2)),
          );
          onOutcome({ status: "retried", attempt: attempt + 1, reason: tooLarge });
          continue;
        }
        // Every converging span has been tried. Fall through to the reset —
        // the rung that always succeeds because it bounds its own output.
        return reset(messages, start, summary, tooLarge, budget, continuityBlock, onOutcome);
      }

      onOutcome({
        status: "shortened",
        summarizedMessages: middle.length,
        summaryTokens,
      });

      return {
        fromMessageId: first.id,
        toMessageId: last.id,
        summary: buildCheckpointText(summary, continuityBlock),
      };
    }

    onOutcome({ status: "failed", error: "compaction retries exhausted" });
    return null;
  };
}
