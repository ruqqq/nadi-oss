import { isCompactionMessage } from "agents/experimental/memory/utils";
import type { UIMessage } from "ai";
import {
  modelSwitchPart,
  readModelSwitchPart,
  sameModelTuple,
  type ModelSwitchData,
  type ModelTuple,
} from "./model-switch";
import { assignOrDelete, stripProviderEntry } from "./provider-metadata-strip";

/**
 * Drop reasoning that a DIFFERENT model produced.
 *
 * Runs during UI-message assembly — NOT after `convertToModelMessages`, which
 * discards the `data-model-switch` markers this function reads.
 *
 * Origin comes from marker position: everything between two markers was
 * produced by one `(provider, model)` tuple. The transcript's CURRENT tuple is
 * the last marker's `to`, so this is a pure function of the transcript and
 * needs no config read. That purity is what makes it deterministic, and
 * determinism is what keeps prompt caching to a single miss per switch: a
 * history-dependent rule ("strip what came before the most recent switch")
 * would mutate the prompt prefix on EVERY later turn.
 *
 * A thread with no markers is one segment, so pre-existing threads keep all
 * their reasoning and need no backfill.
 */
export function sanitizeCrossModelReasoning(messages: UIMessage[]): UIMessage[] {
  const segments = segmentTuples(messages);
  const current = segments.current;
  if (!current) return messages;

  let changed = false;
  const next = messages.map((message, index) => {
    const origin = segments.byIndex[index];
    if (!origin || sameModelTuple(origin, current)) return message;
    const parts = message.parts.filter((part) => part.type !== "reasoning");
    if (parts.length === message.parts.length) return message;
    changed = true;
    return { ...message, parts: parts.map(stripForeignProviderData(origin.provider)) };
  });

  return changed ? next : messages;
}

/** A dropped reasoning part can leave its provider's ids on NEIGHBOURING parts
 *  (OpenAI stamps `itemId` on text parts of the same response item). Strip the
 *  foreign provider's namespace from every surviving part in that message. */
function stripForeignProviderData(provider: string) {
  return (part: UIMessage["parts"][number]): UIMessage["parts"][number] => {
    // Every UI message part is a plain object at runtime; only some variants
    // (e.g. `step-start`) declare `providerMetadata` in the type. Read it
    // through an untyped view rather than narrowing the whole union.
    const record = part as unknown as Record<string, unknown>;
    const nextMetadata = stripProviderEntry(record.providerMetadata, provider);
    if (nextMetadata === record.providerMetadata) return part;
    const next: Record<string, unknown> = { ...record };
    assignOrDelete(next, "providerMetadata", nextMetadata);
    return next as UIMessage["parts"][number];
  };
}

function segmentTuples(messages: UIMessage[]): {
  byIndex: Array<ModelTuple | undefined>;
  current: ModelTuple | undefined;
} {
  const byIndex: Array<ModelTuple | undefined> = new Array(messages.length);
  let active: ModelTuple | undefined;
  let sawMarker = false;

  messages.forEach((message, index) => {
    for (const part of message.parts) {
      const marker = readModelSwitchPart(part);
      if (!marker) continue;
      // The FIRST marker also tells us what everything before it ran on.
      if (!sawMarker) {
        for (let i = 0; i < index; i += 1) byIndex[i] = marker.from;
        sawMarker = true;
      }
      active = marker.to;
    }
    byIndex[index] = active;
  });

  // No marker anywhere: one segment, nothing to compare against.
  if (!sawMarker) return { byIndex: new Array(messages.length), current: undefined };
  return { byIndex, current: active };
}

/**
 * The durable record of where the CURRENT segment begins, written by
 * `commitPendingModelSwitch`. `anchorMessageId` is the message the transcript
 * marker was attached to.
 */
export interface ModelSwitchOrigin extends ModelSwitchData {
  anchorMessageId?: string;
}

/**
 * Re-establish segmentation when the transcript no longer carries the marker.
 *
 * Compaction ARCHIVES a contiguous middle span and replaces it with a summary
 * message that has one text part — so a marker that sat inside that span is
 * simply gone, and `sanitizeCrossModelReasoning` then sees ONE segment and
 * concludes everything is same-origin. On a thread that switched away from a
 * reasoning model, the protected head still holds signed reasoning from the
 * OLD model, and it would be replayed at the new one. That is the exact
 * failure the marker exists to prevent, so the marker cannot be allowed to be
 * the only copy of the origin: this function restores it from DO storage.
 *
 * Injection position, in order of preference:
 *  1. Nothing to do — the transcript's CURRENT tuple (the last surviving
 *     marker's `to`, as `segmentTuples` computes it) is already `origin.to`.
 *  2. The anchor message itself, if it is still in the transcript (covers a
 *     transcript write that never landed, and any pre-existing thread whose
 *     marker was lost some other way).
 *  3. The LAST compaction summary message: the anchor was archived, so the
 *     switch happened at or before the end of that archived span. Choosing the
 *     last (not the first) summary is deliberate — with several summaries it
 *     can attribute a few post-switch messages to the OLD tuple, which drops
 *     reasoning that could have been kept. That is the safe direction; the
 *     reverse would replay foreign reasoning.
 *
 * If neither anchor nor summary is present the transcript is returned
 * unchanged: with no position to anchor to there is no marker semantics to
 * express, and a marker at index 0 would claim the whole transcript is
 * post-switch — the unsafe reading.
 *
 * Pure, and deterministic given (transcript, origin) — the same property
 * `sanitizeCrossModelReasoning` relies on for prompt caching.
 */
export function restoreModelSwitchMarker(
  messages: UIMessage[],
  origin: ModelSwitchOrigin | null | undefined,
): UIMessage[] {
  if (!origin) return messages;
  if (sameModelTuple(origin.from, origin.to)) return messages;
  // "Does the transcript already sit on `origin.to`?" is a question about the
  // CURRENT tuple, not about whether SOME surviving marker happens to name it.
  // An oscillating thread (A->B on m10, B->A on m20, A->B on m30) whose last
  // switch was archived still carries a `to: B` marker on m10 while the last
  // surviving marker leaves the transcript on A — skipping restoration there
  // hands the head's A-origin reasoning to B. Reuse `segmentTuples`, the
  // sanitizer's own notion of "current", so the two cannot disagree.
  const current = segmentTuples(messages).current;
  if (current && sameModelTuple(current, origin.to)) return messages;

  const index = injectionIndex(messages, origin.anchorMessageId);
  if (index === -1) return messages;

  const part = modelSwitchPart({
    from: origin.from,
    to: origin.to,
  }) as unknown as UIMessage["parts"][number];
  return messages.map((message, at) =>
    at === index ? { ...message, parts: [part, ...message.parts] } : message,
  );
}

function injectionIndex(messages: UIMessage[], anchorMessageId: string | undefined): number {
  if (anchorMessageId) {
    const at = messages.findIndex((message) => message.id === anchorMessageId);
    if (at !== -1) return at;
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (isCompactionMessage(messages[i] as never)) return i;
  }
  return -1;
}
