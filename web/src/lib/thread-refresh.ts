import type { ThreadSummary } from "../threads-api";
import { isNetworkFailure } from "./offline-state";

/**
 * Resolves one page-one refresh. That is genuinely all this function does:
 * fetch a page, or on a network failure hand back a no-op page instead of
 * throwing. The merge into the shared active-threads array (merge, never
 * replace) happens at the call site, `refreshActiveThreads` in App.tsx — NOT
 * here, and NOT under a unit test. `ChatApp` is not exported and has no test
 * harness, so "the caller folds this in via `mergeThreads`, not a replace" is
 * a real, accepted coverage gap, not something this file can guard. If a
 * future change reverts that call site to `setThreads(result.threads)`, no
 * test in this repo will catch it — only manual/visual verification would.
 *
 * `nextCursor` is `undefined` on the offline fallback specifically so the
 * caller can leave `threadsNextCursor` untouched rather than overwrite it
 * with a guess — only a real fetch knows whether there is a next page.
 *
 * The offline fallback returns an EMPTY page, not `current()` fed back in as
 * the page. `current` used to be threaded through for a self-merge, but in
 * `mergeThread` the page wins over the base, so merging a stale snapshot of
 * `current` back in as the "fresh" page could revert a row the base array
 * already had more recent data for (see App.tsx's threadsRef timing). An
 * empty page merged in is provably a no-op regardless of staleness.
 */
export async function resolveRefreshedThreadsPage(input: {
  list: () => Promise<{ threads: ThreadSummary[]; nextCursor: string | null }>;
}): Promise<{ threads: ThreadSummary[]; nextCursor: string | null | undefined }> {
  try {
    return await input.list();
  } catch (error) {
    if (!isNetworkFailure(error)) throw error;
    return { threads: [], nextCursor: undefined };
  }
}
