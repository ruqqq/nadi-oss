import type { ThreadSummary } from "../threads-api";

/**
 * Whether the on-screen thread should be marked seen. True when the tab is
 * visible and the thread still carries an unread outcome — opening a thread is
 * what clears its "new reply" / "failed" marker.
 *
 * The route effect only marks seen on navigation, so resume-while-already-on-a-
 * thread and live updates that arrive while you're looking at it rely on this
 * predicate instead (see the active-thread effect and useOnResume in App).
 */
export function shouldMarkThreadSeen(
  thread: Pick<ThreadSummary, "unreadOutcome"> | null | undefined,
  visible: boolean,
): boolean {
  return visible && Boolean(thread?.unreadOutcome);
}
