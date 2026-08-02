import type { UIMessage } from "ai";

export interface ArchivedSummary {
  id: string;
  fromMessageId: string;
  toMessageId: string;
  summary: string;
}

/**
 * Render an archived thread the way the live thread read: with each compacted span
 * collapsed behind a "Thread compacted" divider.
 *
 * The archive deliberately stores the RAW transcript — archiving destroys the
 * Durable Object, so the messages a summary hid must survive somewhere, or they are
 * gone for good. But reading an archived thread should still feel like reading the
 * thread did, so the summaries are stored alongside and folded back in HERE, at
 * render time.
 *
 * That is the whole point of keeping them apart: a summary is a VIEW. Storing it as
 * a message is what corrupted live threads (the client echoed one back and the
 * server persisted it, so the model read the same summary twice, forever). The data
 * stays raw; only the view is compacted.
 *
 * Mirrors the server's `applyCompactions`: at a message that anchors a summary,
 * emit one synthetic `compaction_*` message and skip to the end of the span.
 */
export function applyArchivedCompactions(
  messages: UIMessage[],
  summaries: ArchivedSummary[],
): UIMessage[] {
  if (summaries.length === 0) return messages;

  const ids = messages.map((m) => m.id);
  const result: UIMessage[] = [];
  let i = 0;

  while (i < messages.length) {
    const matching = summaries.filter((s) => s.fromMessageId === ids[i]);
    // Later summaries supersede earlier ones anchored at the same message — a thread
    // that compacts repeatedly re-anchors each new summary at the first one's start.
    const summary = matching[matching.length - 1];

    if (summary) {
      const end = ids.indexOf(summary.toMessageId);
      if (end >= i) {
        result.push({
          id: `compaction_${summary.id}`,
          role: "assistant",
          parts: [{ type: "text", text: summary.summary }],
        } as UIMessage);
        i = end + 1;
        continue;
      }
    }

    const message = messages[i];
    if (message) result.push(message);
    i++;
  }

  return result;
}
