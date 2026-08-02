import { toast } from "sonner";
import { Bell, CheckCircle, WarningCircle } from "@/icons";
import { cn } from "@/lib/utils";
import type { ThreadActivityNotice, ThreadNoticeKind } from "./thread-activity-notice";

/**
 * The in-app counterpart to a push notification: something finished, failed or
 * is waiting on you in a thread you are not looking at.
 *
 * Anchored TOP, deliberately unlike every other toast in the app. The bottom
 * dock is for consequences of something you just did ("Copied", "Saved") and
 * sits over the composer where your attention already is. These are the
 * opposite: news from elsewhere, nothing to act on this second. Putting them
 * where the OS would have drawn its banner keeps them out of the way of the
 * thing you are actually doing.
 *
 * The rail is still the durable record — every one of these has a matching
 * marker there — so a toast that times out unseen loses nothing.
 */

const COPY: Record<ThreadNoticeKind, { label: string; body: string; durationMs: number }> = {
  attention: {
    label: "Needs you",
    body: "Waiting for your approval.",
    // Longest of the three: an agent is blocked until this is answered. Still
    // finite — the rail's attention halo is what actually persists.
    durationMs: 12_000,
  },
  failed: { label: "Failed", body: "The run stopped on an error.", durationMs: 8_000 },
  completed: { label: "Finished", body: "Nadi finished this run.", durationMs: 6_000 },
};

const ICON: Record<ThreadNoticeKind, typeof Bell> = {
  attention: Bell,
  failed: WarningCircle,
  completed: CheckCircle,
};

const TONE: Record<ThreadNoticeKind, string> = {
  attention: "text-gate",
  failed: "text-reject",
  completed: "text-approve",
};

export function showThreadActivityToast(
  notice: ThreadActivityNotice,
  onOpen: (threadId: string) => void,
): void {
  const copy = COPY[notice.kind];
  const Icon = ICON[notice.kind];

  toast.custom(
    (id) => (
      <div className="flex w-full items-start gap-3 rounded-lg border border-border bg-popover p-3 shadow-lg">
        <Icon className={cn("mt-0.5 size-4 shrink-0", TONE[notice.kind])} weight="fill" />
        <div className="min-w-0 flex-1">
          <p className="text-[0.625rem] uppercase tracking-[0.09em] font-semibold text-muted-foreground">
            {copy.label}
          </p>
          <p className="truncate font-medium text-foreground text-sm">{notice.title}</p>
          {/* The reply itself when the turn produced prose, the generic line
              when it did not. Two lines and then clipped: this is an excerpt to
              recognise the thread by, not the message — the thread is one tap
              away. Unlike push, never gated on a preference (see the type). */}
          <p className="mt-0.5 line-clamp-2 text-muted-foreground text-xs">
            {notice.preview ?? copy.body}
          </p>
        </div>
        <button
          className="shrink-0 rounded-md bg-primary px-2.5 py-1 font-semibold text-primary-foreground text-xs"
          onClick={() => {
            toast.dismiss(id);
            onOpen(notice.threadId);
          }}
          type="button"
        >
          Open
        </button>
      </div>
    ),
    {
      // Keyed on the thread: a run that gates, then gates again, replaces its
      // own toast instead of stacking a column of the same thread.
      id: `thread-activity:${notice.threadId}`,
      duration: copy.durationMs,
      position: "top-center",
      className: "w-full",
    },
  );
}
