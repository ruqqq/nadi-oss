import { cn } from "../../lib/utils";

/**
 * The end-of-list affordance for a progressively rendered list.
 *
 * A real button, not a bare sentinel div. The observer usually grows the list
 * before this is ever seen, but where it can't — no IntersectionObserver, or a
 * keyboard user tabbing off the last row — this is the way to the rest of the
 * list rather than a dead end.
 */
export function ShowMoreRow({
  remaining,
  noun,
  onShowMore,
  sentinelRef,
  className,
}: {
  remaining: number;
  /** Singular; pluralised here so callers can't disagree about how. */
  noun: string;
  onShowMore: () => void;
  sentinelRef: (node: HTMLElement | null) => void;
  className?: string;
}) {
  return (
    <button
      ref={sentinelRef}
      type="button"
      onClick={onShowMore}
      className={cn(
        "w-full px-4 py-3 text-center text-muted-foreground text-sm transition-colors hover:bg-accent/60 hover:text-foreground",
        className,
      )}
    >
      Show {remaining} more {remaining === 1 ? noun : `${noun}s`}
    </button>
  );
}
