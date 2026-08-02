import { useCallback, useEffect, useState } from "react";

/**
 * Render a long list a page at a time, growing as its end comes into view.
 *
 * This is a render budget, not a fetch. The thread lists are already in memory —
 * the rail holds every active chat so search and project filters can stay local —
 * so what this cuts is DOM and reconciliation, not bytes over the wire.
 *
 * `resetKey` decides when to start over, rather than the array itself: callers
 * build their list inline (`threads.filter(...)`), so its identity changes on
 * every render and keying on it would pin the list to its first page forever.
 */
export function useProgressiveList<T>(
  items: T[],
  { pageSize, resetKey }: { pageSize: number; resetKey: string },
): {
  visible: T[];
  hasMore: boolean;
  /** How many rows are held back — the affordance says so rather than hinting. */
  remaining: number;
  showMore: () => void;
  sentinelRef: (node: HTMLElement | null) => void;
} {
  const [count, setCount] = useState(pageSize);
  const [sentinel, setSentinel] = useState<HTMLElement | null>(null);

  // A different list is a different read: start it at the top rather than
  // carrying however far the last one had been scrolled.
  useEffect(() => {
    setCount(pageSize);
  }, [resetKey, pageSize]);

  const hasMore = items.length > count;
  const showMore = useCallback(() => setCount((current) => current + pageSize), [pageSize]);

  useEffect(() => {
    if (!sentinel || !hasMore) return;
    // Absent in jsdom, and in any browser old enough to lack it. The list still
    // works — ShowMoreRow is a real button — so degrade rather than throw.
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) showMore();
      },
      // Grow before the end is reached, so scrolling doesn't stall at the seam.
      { rootMargin: "300px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
    // `count` is a dependency on purpose: an observer reports a *change* in
    // intersection, so if a page lands with the sentinel still on screen (a tall
    // viewport, a short page) nothing fires again and the list wedges half-read.
    // Re-observing re-reports the current state, filling the viewport until
    // hasMore goes false and this bails.
  }, [sentinel, hasMore, count, showMore]);

  return {
    // Slicing an already-complete list would copy it on every render for nothing.
    visible: count >= items.length ? items : items.slice(0, count),
    hasMore,
    remaining: Math.max(0, items.length - count),
    showMore,
    sentinelRef: setSentinel,
  };
}
