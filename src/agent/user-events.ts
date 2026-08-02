import type { ThreadSummary } from "../http/thread-serialize";

export type UserEvent =
  | { type: "thread.created"; thread: ThreadSummary }
  /**
   * `preview` rides along only on a lifecycle broadcast (a turn that finished,
   * failed, or stopped for approval), carrying the same excerpt the push would
   * have used so the in-app notice can say the same thing.
   *
   * It is NOT on the thread row on purpose. `lastMessagePreview` looks like it
   * would do the job, but the search projector writes it from `ctx.waitUntil`,
   * racing this broadcast — at this instant it is often still the *user's* last
   * message. Carrying the excerpt on the event makes the notice correct by
   * construction instead of correct-when-the-projector-wins.
   *
   * Unlike push, this is not gated on `pushPreviewEnabled`: that setting exists
   * because a push preview lands on a lock screen. In-app it is already on an
   * authenticated screen the user is looking at.
   */
  | { type: "thread.updated"; thread: ThreadSummary; preview?: string }
  | { type: "thread.archived"; thread: ThreadSummary }
  | { type: "thread.deleted"; threadId: string; workspaceId: string }
  | { type: "feedback.report.created"; reportId: string; submittedAt: number };
