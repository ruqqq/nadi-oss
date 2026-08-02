/**
 * The excerpt of an assistant reply that a push notification may show.
 *
 * Deliberately structural and dependency-free: it walks plain objects so it can
 * be unit-tested without the agent runtime, and it is total — malformed input
 * yields null rather than throwing, because the caller is on a best-effort
 * notification path where losing the push would be worse than losing the body.
 */

/** Android collapses the body to ~2 lines, iOS shows ~4. 160 fills that. */
const MAX_PREVIEW_LENGTH = 160;

export interface PushPreviewPart {
  type?: unknown;
  text?: unknown;
}

export interface PushPreviewMessage {
  role?: unknown;
  parts?: unknown;
}

/**
 * Reads the trailing text of the last assistant message in the turn.
 *
 * Role matters: turn-end injection flush can append a user-role system-reminder
 * after the assistant reply, and quoting that on a lock screen would be wrong.
 * Messages without a role (unit fixtures, older shapes) still count so the
 * extractor stays total over plain objects.
 *
 * Only `text` parts are kept. Reasoning is excluded on purpose — a model's
 * private deliberation on someone's lock screen is the worst version of this
 * feature — and so are tool and file parts, which are not prose.
 */
export function extractPushPreview(messages: readonly PushPreviewMessage[]): string | null {
  const message = lastAssistantMessage(messages);
  const parts = message?.parts;
  if (!Array.isArray(parts)) {
    return null;
  }

  const text = (parts as PushPreviewPart[])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  if (text.length === 0) {
    return null;
  }
  if (text.length <= MAX_PREVIEW_LENGTH) {
    return text;
  }

  const clipped = text.slice(0, MAX_PREVIEW_LENGTH);
  const lastSpace = clipped.lastIndexOf(" ");
  // A single word longer than the limit has no boundary to cut on; take the
  // hard slice rather than returning nothing.
  const cut = lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped;
  return `${cut.trimEnd()}…`;
}

function lastAssistantMessage(
  messages: readonly PushPreviewMessage[],
): PushPreviewMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message) continue;
    // Skip known non-assistant roles; accept assistant and role-less shapes.
    if (message.role === "user" || message.role === "system") continue;
    return message;
  }
  return undefined;
}
