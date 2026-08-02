import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ThreadSummary } from "../threads-api";

/**
 * Owns cursor/exhausted/loading/error and the fetch loop for one paginated
 * thread query. Owns NO data and does NO filtering — `onPage` hands each page
 * to the caller, who decides where it lands (the shared active array, or a
 * surface's own separate state for archived threads). That split is what lets
 * one hook serve both without archived threads ever entering the array the
 * rail renders unfiltered.
 */
export function useThreadQuery(input: {
  /** Identity of the query. A change resets to page one. Callers build it from
   *  (status, project, q) — NOT from an array, whose identity changes every render. */
  key: string;
  /** Fetch one page. `cursor` is undefined for page one. */
  fetchPage: (cursor?: string) => Promise<{ threads: ThreadSummary[]; nextCursor: string | null }>;
  /** Receive a page. `reset` is true for page one — the caller replaces vs appends. */
  onPage: (threads: ThreadSummary[], meta: { reset: boolean }) => void;
  enabled?: boolean;
}): {
  loading: boolean;
  error: Error | null;
  /** True only once a page has returned `nextCursor: null`. The empty state
   *  depends on this, so a wrongly-true value is a confident lie. */
  exhausted: boolean;
  hasMore: boolean;
  loadMore: () => void;
  reload: () => void;
} {
  const { key, fetchPage, onPage, enabled = true } = input;

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [exhausted, setExhausted] = useState(false);

  // Latest callbacks in refs so the fetch loop below doesn't need them as
  // dependencies (fetchPage/onPage are commonly fresh closures each render).
  // Latched in useLayoutEffect, not during render: a discarded render (e.g.
  // Suspense/offscreen) must not leave the ref pointing at a closure from a
  // render that never committed.
  const fetchPageRef = useRef(fetchPage);
  const onPageRef = useRef(onPage);
  useLayoutEffect(() => {
    fetchPageRef.current = fetchPage;
    onPageRef.current = onPage;
  });

  const cursorRef = useRef<string | undefined>(undefined);
  const loadingRef = useRef(false);
  // Race-free mirror of `exhausted` state, read by loadMore. State is not
  // enough: loadMore's identity changes when `exhausted` flips, so any caller
  // holding a captured reference (an IntersectionObserver effect with `[]`
  // deps, for instance) would keep running against the pre-exhaustion
  // closure and re-issue a page-one fetch after the list is fully paged.
  const exhaustedRef = useRef(false);
  // Bumped on every key change (and reload); a response is only applied if
  // this still matches the generation it was issued under. This is the
  // stale-response guard: the slower of two overlapping fetches for a query
  // the user has moved past must never be applied, and must not corrupt
  // cursor/exhausted for the CURRENT query.
  const generationRef = useRef(0);
  // True once the first fetch for the current key has been kicked off. The
  // fetch starts in an effect, which runs AFTER the first paint, so without
  // this `hasMore` would read true for a frame (and permanently under
  // `enabled: false`) before any request exists.
  const startedRef = useRef(false);

  const runFetch = useCallback((cursor: string | undefined, generation: number) => {
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    fetchPageRef.current(cursor).then(
      (page) => {
        if (generationRef.current !== generation) return;
        loadingRef.current = false;
        setLoading(false);
        cursorRef.current = page.nextCursor ?? undefined;
        exhaustedRef.current = page.nextCursor === null;
        setExhausted(exhaustedRef.current);
        onPageRef.current(page.threads, { reset: cursor === undefined });
      },
      (err: unknown) => {
        if (generationRef.current !== generation) return;
        loadingRef.current = false;
        setLoading(false);
        setError(err instanceof Error ? err : new Error(String(err)));
      },
    );
  }, []);

  // A change in `key` (or toggling enabled on) starts a fresh page-one fetch
  // and invalidates any fetch still in flight for the old query.
  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    cursorRef.current = undefined;
    loadingRef.current = false;
    exhaustedRef.current = false;
    setError(null);
    setExhausted(false);
    setLoading(false);
    if (enabled) {
      startedRef.current = true;
      runFetch(undefined, generation);
    } else {
      startedRef.current = false;
    }
    // Invalidate any fetch still in flight once this effect's query is torn
    // down (unmount, or a re-run for a new key) — its resolution must not
    // write into a surface the caller has left.
    return () => {
      generationRef.current += 1;
    };
  }, [key, enabled, runFetch]);

  const loadMore = useCallback(() => {
    if (!enabled || loadingRef.current || exhaustedRef.current) return;
    runFetch(cursorRef.current, generationRef.current);
  }, [enabled, runFetch]);

  const reload = useCallback(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    cursorRef.current = undefined;
    exhaustedRef.current = false;
    setExhausted(false);
    if (!enabled) return;
    startedRef.current = true;
    runFetch(undefined, generation);
  }, [enabled, runFetch]);

  return {
    loading,
    error,
    exhausted,
    hasMore: !exhausted && startedRef.current,
    loadMore,
    reload,
  };
}
