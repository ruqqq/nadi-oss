import type { UIMessage } from "ai";
import { readModelSwitchPart, sameModelTuple, type ModelTuple } from "./model-switch";
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
