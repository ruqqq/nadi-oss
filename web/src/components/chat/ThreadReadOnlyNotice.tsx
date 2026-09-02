import { readOnlyNoticeForThread } from "../../thread-runtime-routing";
import type { ThreadSummary } from "../../threads-api";

/**
 * The bar that stands where the composer would be on a read-only thread. It
 * says WHY the chat is read-only, so the reader learns it here rather than by
 * typing a message and watching the server refuse it.
 *
 * It explains; it does not enforce. The turn is still refused server-side
 * (`think-thread-agent.ts`, `AgentSandbox.acquire`), and both gates read D1
 * live, so nothing here can be talked out of them.
 */
export function ThreadReadOnlyNotice({ thread }: { thread: ThreadSummary }) {
  const notice = readOnlyNoticeForThread(thread);
  return (
    <div
      className="shrink-0 border-border border-t bg-card px-4 py-3 text-center text-muted-foreground text-sm standalone:pb-[calc(0.75rem_+_env(safe-area-inset-bottom))]"
      data-testid="thread-read-only-notice"
    >
      <span className="text-foreground">{notice.fact}</span>
      {/* A real space, not a margin: the two clauses are one sentence pair, and
          a margin leaves them run together for a screen reader and on copy. */}
      {notice.fix === null ? null : <span>{` ${notice.fix}`}</span>}
    </div>
  );
}
