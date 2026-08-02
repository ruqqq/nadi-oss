import type { ThreadSummary } from "../../threads-api";

export type IndicatorKind = "responding" | "attention" | "unread";

/**
 * Resolve the single most important status marker for a sidebar thread row.
 * Live work (attention/running) outranks unread outcomes; a seen, idle thread
 * has no marker. Order here is the priority order.
 *
 * A failed outcome shares the unread mark — both mean "a new result you have
 * not looked at" — but keeps its own label, so the failure survives in the
 * tooltip and for screen readers without spending another colour on it.
 */
export function indicatorFor(thread: ThreadSummary): { kind: IndicatorKind; label: string } | null {
  if (thread.activityStatus === "attention_required") {
    return { kind: "attention", label: "Waiting for you" };
  }
  if (thread.activityStatus === "running") {
    return { kind: "responding", label: "Responding" };
  }
  if (thread.unreadOutcome === "failed") {
    return { kind: "unread", label: "Failed" };
  }
  if (thread.unreadOutcome === "completed") {
    return { kind: "unread", label: "New reply" };
  }
  return null;
}

/**
 * Per-thread status marker for the sidebar rows. Every marker is a circle, and
 * the whole vocabulary reduces to one sentence: aubergine is information, amber
 * is you. Motion means in progress; the halo means act now.
 * Renders nothing for idle, already-seen threads.
 */
export function ThreadIndicator({ thread }: { thread: ThreadSummary }) {
  const indicator = indicatorFor(thread);
  if (!indicator) return null;

  return (
    <span
      className="inline-flex shrink-0 items-center justify-center"
      role="status"
      aria-label={indicator.label}
      title={indicator.label}
    >
      <IndicatorMark kind={indicator.kind} />
      <span className="sr-only">{indicator.label}</span>
    </span>
  );
}

function IndicatorMark({ kind }: { kind: IndicatorKind }) {
  switch (kind) {
    case "responding":
      // Motion is the meaning: a solid dot under a ping ring. Same hue as
      // unread — only the animation separates "working" from "waiting to read".
      return (
        <span className="relative inline-flex size-2.5 items-center justify-center">
          <span className="absolute inline-flex size-2.5 rounded-full bg-primary/40 motion-safe:animate-ping" />
          <span className="relative inline-flex size-2 rounded-full bg-primary" />
        </span>
      );
    case "attention":
      // The one "act now" state, and the only amber mark in the sidebar. The
      // static halo gives it more weight than the plain dots without a chip.
      return (
        <span className="relative inline-flex size-2.5 items-center justify-center">
          <span className="inline-flex size-2 rounded-full bg-steer ring-[3px] ring-steer/25" />
        </span>
      );
    case "unread":
      return <span className="inline-flex size-2 rounded-full bg-primary" />;
  }
}

/**
 * The one marker to put on the rail toggle, for when the rail itself is a
 * drawer and its rows are out of sight.
 *
 * Derived from `indicatorFor`, deliberately — the badge and the rows must never
 * be able to disagree about what counts, or the dot sends you looking for
 * something that isn't marked.
 *
 * "Responding" is excluded: a thread mid-turn is not something you have missed,
 * and badging it would light the toggle for most of a working session, which is
 * how an indicator becomes wallpaper. Attention outranks unread, matching the
 * row priority.
 */
export function railToggleIndicator(
  threads: ThreadSummary[],
): { kind: "attention" | "unread"; label: string } | null {
  let unread: { kind: "unread"; label: string } | null = null;
  for (const thread of threads) {
    const indicator = indicatorFor(thread);
    if (indicator?.kind === "attention") {
      return { kind: "attention", label: "Waiting for you" };
    }
    if (indicator?.kind === "unread" && !unread) {
      unread = { kind: "unread", label: "Unread chats" };
    }
  }
  return unread;
}
