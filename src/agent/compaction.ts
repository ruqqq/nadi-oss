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
import { CHARS_PER_TOKEN, type ContextBudget } from "./context-budget";
import { boundText, MARKER_MAX_CHARS } from "./transcript-bounding";

type ThreadMessages = Parameters<typeof estimateMessageTokens>[0];
type ThreadMessage = ThreadMessages[number];

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

/** How much of a tool's input/output the summarizer is shown. The output
 * allowance is deliberately larger than the SDK's 500 — a summarizer that cannot
 * see the result cannot preserve it. */
const SUMMARY_INPUT_CHARS = 500;
const SUMMARY_OUTPUT_CHARS = 2_000;

/**
 * Tool outputs, serialized for the summarizer.
 *
 * The SDK's buildSummaryPrompt does `String(output).slice(0, 500)`. Nadi's
 * capToolOutput deliberately preserves object shape and most Nadi tools return
 * objects — so the summarizer read the literal string "[object Object]" for
 * every one of them, and wrote every summary blind to what the tools did.
 */
export function serializeToolOutputForSummary(output: unknown, maxChars: number): string {
  if (output === null || output === undefined) return "";
  const text = typeof output === "string" ? output : safeStringify(output);
  return text.length > maxChars
    ? `${text.slice(0, maxChars)}... [truncated ${text.length} chars]`
    : text;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

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

type RenderablePart = {
  type: string;
  text?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
};

function isToolPart(part: RenderablePart): boolean {
  return part.type.startsWith("tool-") || part.type === "dynamic-tool";
}

function renderMessage(message: ThreadMessage): string {
  const parts = message.parts as unknown as RenderablePart[];
  const text = parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
  const tools = parts
    .filter(isToolPart)
    .map((part) =>
      [
        `[Tool: ${part.toolName ?? "unknown"}]`,
        `Input: ${serializeToolOutputForSummary(part.input, SUMMARY_INPUT_CHARS)}`,
        `Output: ${serializeToolOutputForSummary(part.output, SUMMARY_OUTPUT_CHARS)}`,
      ].join("\n"),
    )
    .join("\n");
  return `[${message.role}]\n${text}${tools ? `\n${tools}` : ""}`;
}

function buildPrompt(
  middle: ThreadMessages,
  previousSummary: string | null,
  targetTokens: number,
): string {
  const content = middle.map(renderMessage).join("\n\n---\n\n");
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
    "[Unresolved questions, pending tasks, next steps]",
  ].join("\n");
  const tail = `Target ~${targetTokens} tokens. Be factual — only include information explicitly present above. Do NOT invent file paths, commands, or details. Write only the summary body.`;

  if (previousSummary) {
    return `You are updating a conversation summary. A previous summary exists below. New turns have occurred since and need to be incorporated.\n\nPREVIOUS SUMMARY:\n${previousSummary}\n\nNEW TURNS TO INCORPORATE:\n${content}\n\nUpdate the summary. PRESERVE existing information that is still relevant. ADD new information. Remove information only if clearly obsolete.\n\n${structure}\n\n${tail}`;
  }
  return `Create a concise summary of this conversation that preserves the important information for future context.\n\nCONVERSATION TO SUMMARIZE:\n${content}\n\n${structure}\n\n${tail}`;
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
  // Strictly within the summary budget: the marker's own width counts, or the
  // reset overshoots the very floor it exists to collapse.
  const bounded = boundText(
    summary,
    Math.max(1, budget.maxSummaryTokens * CHARS_PER_TOKEN - MARKER_MAX_CHARS),
    0,
  );
  onOutcome({ status: "reset", discardedMessages: span.length, reason });
  return {
    fromMessageId: first.id,
    toMessageId: lastSummarized.id,
    summary: bounded,
    reset: true,
  };
}

export function createNadiCompactFunction(opts: {
  budget: ContextBudget;
  summarize: (prompt: string) => Promise<string>;
  onOutcome: (outcome: CompactionOutcome) => void;
}) {
  const { budget, summarize, onOutcome } = opts;

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
      ? (existing.parts as unknown as { type: string; text?: string }[])
          .filter((p) => p.type === "text")
          .map((p) => p.text ?? "")
          .join("\n")
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
        summary = await summarize(buildPrompt(middle, previousSummary, targetTokens));
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
        return reset(messages, start, summary, tooLarge, budget, onOutcome);
      }

      onOutcome({
        status: "shortened",
        summarizedMessages: middle.length,
        summaryTokens,
      });

      return {
        fromMessageId: first.id,
        toMessageId: last.id,
        summary,
      };
    }

    onOutcome({ status: "failed", error: "compaction retries exhausted" });
    return null;
  };
}
