/**
 * Part-level transcript bounding.
 *
 * Bounding is per PART; compaction is per MESSAGE. Conflating the two is what
 * let one assistant turn with 23 tool calls become 96.7% of a thread and stay
 * permanently uncompactable — see
 * `docs/superpowers/specs/2026-08-20-compaction-rewrite-design.md`.
 *
 * Head AND tail are kept: a `git diff` or a test run truncated head-only loses
 * the conclusion, which is the part that carries the outcome. deepseek's pruner
 * uses the same shape (head 4096 / tail 1024).
 *
 * Model-facing only. Callers pass the assembly's copy of the transcript; stored
 * messages are never rewritten.
 */

export type BoundingOptions = {
  partHeadChars: number;
  partTailChars: number;
  minTailMessages: number;
  maxRetainedMessageChars: number;
  /** Hard ceiling on the FIRST message, which compaction never summarizes. */
  headMaxChars: number;
};

type BoundablePart = { type: string; output?: unknown; text?: string };
type BoundableMessage = { parts: readonly BoundablePart[] };

const MARKER_PREFIX = "\n… [truncated ";
const MARKER_SUFFIX = " chars] …\n";
/** Widest the digit run can ever be — bounds the marker without measuring it. */
const MARKER_MAX_DIGITS = 20;
export const MARKER_MAX_CHARS = MARKER_PREFIX.length + MARKER_MAX_DIGITS + MARKER_SUFFIX.length;

const marker = (dropped: number) => `${MARKER_PREFIX}${dropped}${MARKER_SUFFIX}`;

/**
 * Threshold below which bounding is a no-op.
 *
 * It budgets for the WIDEST possible marker, not the one actually emitted, so
 * an emitted result is always <= the threshold and a second pass leaves it
 * alone. Sizing this to the narrowest marker makes bounding non-idempotent: the
 * output stays over the threshold and every pass re-bounds it, re-reporting a
 * smaller "dropped" count each time. Same constraint deepseek's pruner states —
 * head + marker + tail must fit inside the threshold.
 */
function thresholdFor(headChars: number, tailChars: number): number {
  return headChars + tailChars + MARKER_MAX_CHARS;
}

export function boundText(text: string, headChars: number, tailChars: number): string {
  if (text.length <= thresholdFor(headChars, tailChars)) return text;
  const dropped = text.length - headChars - tailChars;
  return `${text.slice(0, headChars)}${marker(dropped)}${text.slice(text.length - tailChars)}`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * An oversized object output becomes a bounded STRING rather than a
 * shape-preserving object. That is safe here and only here: this runs on the
 * model-facing copy, so nothing downstream reads the output programmatically.
 */
export function boundOutput(output: unknown, headChars: number, tailChars: number): unknown {
  if (output === null || output === undefined) return output;
  const text = typeof output === "string" ? output : safeStringify(output);
  if (text.length <= thresholdFor(headChars, tailChars)) return output;
  return boundText(text, headChars, tailChars);
}

function isToolPart(part: BoundablePart): boolean {
  return part.type.startsWith("tool-") || part.type === "dynamic-tool";
}

function partChars(part: BoundablePart): number {
  let total = 0;
  if (typeof part.text === "string") total += part.text.length;
  if (part.output !== undefined) {
    total +=
      typeof part.output === "string" ? part.output.length : safeStringify(part.output).length;
  }
  return total;
}

function messageChars(message: BoundableMessage): number {
  let total = 0;
  for (const part of message.parts) total += partChars(part);
  return total;
}

function boundMessage<T extends BoundableMessage>(message: T, opts: BoundingOptions): T {
  let changed = false;
  const parts = message.parts.map((part) => {
    if (isToolPart(part) && part.output !== undefined) {
      const bounded = boundOutput(part.output, opts.partHeadChars, opts.partTailChars);
      if (bounded !== part.output) {
        changed = true;
        return { ...part, output: bounded };
      }
    }
    if (part.type === "text" && typeof part.text === "string") {
      const bounded = boundText(part.text, opts.partHeadChars, opts.partTailChars);
      if (bounded !== part.text) {
        changed = true;
        return { ...part, text: bounded };
      }
    }
    return part;
  });
  return changed ? ({ ...message, parts } as T) : message;
}

/** Drop trailing parts until the message fits. Leading parts carry the request;
 *  trailing ones are the least load-bearing thing to lose. Always keeps one. */
function capMessageChars<T extends BoundableMessage>(message: T, maxChars: number): T {
  const parts: BoundablePart[] = [];
  let used = 0;
  for (const part of message.parts) {
    const size = partChars(part);
    if (parts.length > 0 && used + size > maxChars) break;
    parts.push(part);
    used += size;
  }
  return { ...message, parts } as T;
}

/**
 * Bound every part outside the retained tail. Messages inside the tail are
 * bounded only when the whole message exceeds `maxRetainedMessageChars` —
 * without that ceiling the tail is unbounded for the same per-message /
 * per-part reason the head was.
 */
export function boundTranscript<T extends BoundableMessage>(
  messages: readonly T[],
  opts: BoundingOptions,
): readonly T[] {
  const tailStart = Math.max(0, messages.length - opts.minTailMessages);
  let changed = false;
  const result = messages.map((message, index) => {
    const exempt = index >= tailStart && messageChars(message) <= opts.maxRetainedMessageChars;
    let bounded = exempt ? message : boundMessage(message, opts);
    // The head is never summarized, so part bounding alone does not bound it:
    // a message with enough bounded parts is still arbitrarily large. Cap the
    // whole message by dropping trailing parts.
    if (index === 0 && messageChars(bounded) > opts.headMaxChars) {
      bounded = capMessageChars(bounded, opts.headMaxChars);
    }
    if (bounded !== message) changed = true;
    return bounded;
  });
  return changed ? result : messages;
}
