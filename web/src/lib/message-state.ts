import type { UIMessage } from "ai";

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
