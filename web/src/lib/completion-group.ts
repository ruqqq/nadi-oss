import type { UIMessage } from "ai";
import { isSubagentCompletionMessage } from "./subagent-runs";
import { isWatcherCompletionMessage } from "./watcher-runs";

// Grouping for the chat transcript: watcher/subagent completions are delivered
// as a consecutive RUN of messages (they persist mid-turn while the assistant
// message persists only at turn end, so they cluster just before it). We render
// such a run as ONE collapsible CompletionGroup instead of N cards, and — when
// the run is immediately followed by the turn's assistant response — reorder so
// the response renders FIRST and the results group sits beneath it (a "here's
// what finished, if you're interested" footer). Pure + display-only: the model
// still received each completion individually for steering.

export function isCompletionMessage(message: UIMessage): boolean {
  return isWatcherCompletionMessage(message) || isSubagentCompletionMessage(message);
}

export type ChatRenderItem =
  | { kind: "message"; message: UIMessage }
  | { kind: "completions"; run: UIMessage[] };

export function groupChatMessages(messages: UIMessage[]): ChatRenderItem[] {
  const items: ChatRenderItem[] = [];
  let i = 0;
  while (i < messages.length) {
    const message = messages[i];
    if (message === undefined) break;
    if (!isCompletionMessage(message)) {
      items.push({ kind: "message", message });
      i += 1;
      continue;
    }
    // Collect the consecutive completion run.
    const run: UIMessage[] = [];
    while (i < messages.length) {
      const m = messages[i];
      if (m === undefined || !isCompletionMessage(m)) break;
      run.push(m);
      i += 1;
    }
    // Reorder: a run immediately followed by an assistant message renders the
    // response first, then the group beneath it.
    const next = messages[i];
    if (next !== undefined && next.role === "assistant") {
      items.push({ kind: "message", message: next });
      items.push({ kind: "completions", run });
      i += 1;
    } else {
      items.push({ kind: "completions", run });
    }
  }
  return items;
}
