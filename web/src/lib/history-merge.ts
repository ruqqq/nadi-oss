import type { UIMessage } from "ai";

/**
 * Merge a freshly-fetched server transcript over the local one WITHOUT dropping
 * an assistant reply that is still streaming.
 *
 * Why this exists: mid-turn, the server's persisted history stops at the user
 * message — the assistant message is not written until the turn settles. So a
 * resync that does `setMessages(fresh)` deletes the half-streamed bubble the
 * user is watching, and it only returns once the SDK's resume handshake replays
 * the buffered chunks. That reads like data loss, not like loading.
 *
 * The Agents SDK guards its OWN broadcast path against this
 * (`preserveProtectedStreamingAssistant` in agents/chat/react.js), but that
 * guard is unreachable from `setMessages`, which is what our resync calls. This
 * is the same rule applied at the seam the SDK cannot see.
 *
 * `fresh` stays authoritative: order and per-message content always come from
 * the server. The ONLY thing salvaged is a trailing local assistant message the
 * server has not persisted yet.
 */
export function mergeResyncedHistory(local: UIMessage[], fresh: UIMessage[]): UIMessage[] {
  if (local.length === 0) return fresh;

  const freshIds = new Set(fresh.map((message) => message.id));

  // Anchor on the last message BOTH sides know about, rather than guessing by
  // position: the two arrays can differ in length for reasons that have nothing
  // to do with the current turn.
  let lastSharedLocalIndex = -1;
  for (let i = local.length - 1; i >= 0; i--) {
    const message = local[i];
    if (message && freshIds.has(message.id)) {
      lastSharedLocalIndex = i;
      break;
    }
  }

  // No common ground. This is the compaction case: the server rewrote history
  // out from under us, so "after the last shared message" has no meaning and
  // anything we salvaged would be placed on a guess. Take the server's word.
  if (lastSharedLocalIndex === -1) return fresh;

  const tail = local
    .slice(lastSharedLocalIndex + 1)
    // User messages are persisted at turn start, so a local-only one means
    // something else is going on; the optimistic-first-message path owns that
    // case and would fight us for it.
    .filter((message) => message.role === "assistant");
  // No id-dedupe needed here, and adding one would be dead code: the anchor is
  // by definition the LAST local index the server knows, so nothing after it
  // can carry an id `fresh` already holds.
  if (tail.length === 0) return fresh;

  // The turn settled while we were away and the server already holds the real
  // reply. Salvaging now would strand a dead partial next to the finished
  // answer — the exact failure this function is otherwise preventing.
  const lastSharedFreshIndex = fresh.findIndex(
    (message) => message.id === local[lastSharedLocalIndex]?.id,
  );
  const supersededByServer = fresh
    .slice(lastSharedFreshIndex + 1)
    .some((message) => message.role === "assistant");
  if (supersededByServer) return fresh;

  return [...fresh, ...tail];
}
