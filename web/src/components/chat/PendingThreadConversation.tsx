import type { FileUIPart } from "ai";

import { Conversation, ConversationContent } from "@/components/ai-elements/conversation";

import { PendingFirstMessage } from "./PendingFirstMessage";
import { TypingDots } from "./TypingDots";

/**
 * The conversation body shown from the moment a new thread's first message is
 * submitted until the live thread takes over — the optimistic user bubble
 * pinned to the bottom of an (otherwise empty) stick-to-bottom Conversation,
 * with the typing indicator as soon as the message is on its way (even before
 * the thread exists or the stream opens).
 *
 * It mirrors the live ChatLog's layout on purpose: an empty flex-1 Conversation
 * with the bubble as its trailing sibling. That way the bubble keeps the same
 * position and never blinks out as the surface swaps from the create-time
 * projection to the history-loading skeleton to the live thread — the three
 * views are otherwise separate components that would each reflow the message.
 */
export function PendingThreadConversation({
  text,
  files,
  status,
  onRetry,
}: {
  text: string;
  files: FileUIPart[];
  status: "sending" | "sent" | "failed";
  onRetry?: () => void;
}) {
  return (
    <>
      <Conversation className="flex-1">
        <ConversationContent>
          <div aria-hidden className="min-h-0 flex-1" />
        </ConversationContent>
      </Conversation>
      <PendingFirstMessage text={text} files={files} status={status} onRetry={onRetry} />
      {status !== "failed" && (
        <div className="px-4 pb-4">
          <TypingDots />
        </div>
      )}
    </>
  );
}
