/**
 * Pure gating logic for the rail's search UI. Kept out of App.tsx so the
 * "when is this state honest" question can be unit-tested without a component.
 */

/**
 * True only once the rail's server-backed search has settled with zero
 * matches. Never derived from an array length alone: a page still in flight
 * (or a debounce window that hasn't fired the next fetch yet) has a partial
 * or stale array, and rendering "no chats match" against that is a confident
 * lie. Loading and "not yet exhausted" both hold the empty state back.
 *
 * `exhausted`/`loading` are keyed on the DEBOUNCED query, while `matchCount`
 * (the local filter) is keyed on the raw, still-typing query. The two can
 * disagree for the whole debounce window: a prior query's settled
 * `exhausted: true` must not be read as this query's answer, so a caller
 * MUST pass `queryUnsettled: true` whenever the debounced query hasn't
 * caught up to what's on screen yet.
 */
export function isSearchEmpty(input: {
  searching: boolean;
  loading: boolean;
  exhausted: boolean;
  matchCount: number;
  queryUnsettled: boolean;
}): boolean {
  return (
    input.searching &&
    !input.queryUnsettled &&
    !input.loading &&
    input.exhausted &&
    input.matchCount === 0
  );
}

/**
 * True when the rail's unsearched view is capped short of the truth — either
 * the shared array's own page-one fetch says there is more on the server
 * (`threadsNextCursor`), or enough pages have merged in locally to exceed the
 * recent-window cap. A count is not knowable here (no COUNT query, by
 * decision), so this only answers "is there more", not "how much".
 */
export function hasOlderChats(input: {
  threadsNextCursor: string | null;
  threadCount: number;
  recentLimit: number;
}): boolean {
  return input.threadsNextCursor != null || input.threadCount > input.recentLimit;
}
