import type { UIMessage } from "ai";

/**
 * Has this message nothing to paint — no text, no reasoning, no tool call, no
 * file?
 *
 * The SDK inserts a bare `{role: "assistant", parts: []}` the moment a stream
 * opens, before any chunk lands. It draws nothing, but it is still a child of
 * ConversationContent's `gap-8` flex column, so it contributes a 32px gap out
 * of thin air. The typing dots that follow it carry `-mt-8` to cancel ONE such
 * gap, so the placeholder's gap survives and the dots drop 32px the instant a
 * turn starts, then rise again when the first token paints.
 */
export function rendersNoContent(message: UIMessage): boolean {
  const parts = (message as { parts?: { type?: string; text?: string }[] }).parts ?? [];
  // Vacuously true for `parts: []` — which is the case this exists for.
  return parts.every(
    (part) =>
      (part.type === "text" || part.type === "reasoning") && (part.text ?? "").trim() === "",
  );
}

/** Drop assistant rows that would paint nothing, so they cannot contribute a
 *  flex gap. User rows are left alone: the composer cannot submit an empty
 *  message, and an attachment-only one has file parts. */
export function withRenderableContent(messages: UIMessage[]): UIMessage[] {
  return messages.filter((message) => message.role !== "assistant" || !rendersNoContent(message));
}

/**
 * Does this transcript end on a user message — i.e. is a reply owed?
 *
 * Deliberately NOT `!isConversationComplete(messages)`. That predicate asks
 * "is anything streaming right now", so it answers TRUE (complete) for
 * `[user, assistant, user]` — a transcript that plainly stops mid-turn. Every
 * thread past its first turn looks finished to it, which is why the
 * pending-reply indicator only ever appeared on brand-new threads.
 *
 * Mid-turn the server's persisted history stops at the user message, so "ends
 * on a user message" is exactly the shape of a turn still in flight.
 */
export function awaitsAssistantReply(messages: UIMessage[]): boolean {
  return messages[messages.length - 1]?.role === "user";
}

/**
 * Determine whether a conversation is genuinely complete by inspecting the
 * message parts. Used after a PWA background/resume cycle where the AI SDK's
 * internal `isStreaming` flag may be stale because the WebSocket "turn finished"
 * event was missed.
 *
 * Returns true when: at least one assistant message exists AND no part in any
 * message is in a "streaming" or "input-streaming" state.
 */
export function isConversationComplete(messages: UIMessage[]): boolean {
  if (messages.length === 0) return false;

  let hasAssistant = false;

  for (const msg of messages) {
    if (msg.role === "assistant") hasAssistant = true;

    const parts = (msg as { parts?: { type?: string; state?: string }[] }).parts;
    if (!parts) continue;

    for (const part of parts) {
      // Text still arriving
      if (part.type === "text" && part.state === "streaming") return false;
      // Reasoning still streaming
      if (part.type === "reasoning" && part.state === "streaming") return false;
      // Tool-call still receiving input
      if (part.type?.startsWith("tool-") && part.state === "input-streaming") return false;
    }
  }

  return hasAssistant;
}
