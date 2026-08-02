import { ConversationSkeleton } from "./ConversationSkeleton";

/**
 * Suspense fallback for the conversation area, while a lazy child of ChatLog
 * loads.
 *
 * With the optimistic first-message bubble already on screen, placeholder bars
 * above it would be wrong — but rendering NOTHING is wrong too, and that is
 * what a `null` fallback did here. The bubble and its typing dots are siblings
 * BELOW this slot in a flex column, so a zero-height fallback let them ride up
 * to the top of the pane and then snap back down the moment ChatLog resolved.
 *
 * The spacer holds the same space ChatLog will, mirroring the empty `flex-1`
 * Conversation that PendingThreadConversation renders for exactly this reason.
 * Between the two, the bubble keeps its position across every view it passes
 * through.
 */
export function ConversationFallback({ hasPendingBubble }: { hasPendingBubble: boolean }) {
  if (hasPendingBubble) {
    return <div aria-hidden data-testid="conversation-spacer" className="min-h-0 flex-1" />;
  }
  return <ConversationSkeleton />;
}
