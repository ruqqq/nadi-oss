import type { ThreadSummary } from "../threads-api";

/**
 * Whether the user has dismissed this thread from the sidebar rail and the
 * dismissal is still in force.
 *
 * A dismissal is spent the moment the thread sees activity: `updatedAt` moves
 * past the stamp and the thread comes back on its own. That is the whole
 * mechanism — there is no un-dismiss job and no second flag, which is why the
 * server's dismiss write must never touch `updatedAt` (it would spend the
 * dismissal in the same statement that created it).
 *
 * Equal stamps count as dismissed: the write sets `recentDismissedAt` from a
 * clock that can read the same millisecond as an `updatedAt` written moments
 * earlier, and treating that tie as "not dismissed" would make the action
 * appear to do nothing.
 *
 * This is a RAIL concern only. All chats, search, and the projects panel all
 * ignore it — that is what keeps a dismissed thread discoverable rather than
 * archived.
 */
export function isThreadDismissedFromRail(
  thread: Pick<ThreadSummary, "recentDismissedAt" | "updatedAt">,
): boolean {
  const dismissedAt = thread.recentDismissedAt;
  if (dismissedAt == null) return false;
  return dismissedAt >= thread.updatedAt;
}

/**
 * The rail's rendered list. Two threads survive dismissal on purpose:
 *
 * - While searching. The user typed this thread's name; hiding the result is
 *   the bug, not the feature.
 * - The active thread. Dismissing the chat you are reading must not pull it out
 *   from under you — it drops off once you navigate away.
 */
export function visibleRailThreads(
  threads: ThreadSummary[],
  options: { searching: boolean; activeThreadId: string | null },
): ThreadSummary[] {
  if (options.searching) return threads;
  return threads.filter(
    (thread) => thread.threadId === options.activeThreadId || !isThreadDismissedFromRail(thread),
  );
}
