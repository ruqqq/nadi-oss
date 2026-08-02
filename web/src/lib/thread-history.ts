import { useEffect, useRef } from "react";

/**
 * Module-level promise cache for the Suspense-driving thread-history fetch.
 *
 * Two failure modes have to be avoided at once, and they pull in opposite
 * directions:
 *
 * 1. **The retry loop.** React throws away the hook state (refs included) of a
 *    component that suspends before it ever commits. So a per-mount ref cache
 *    is *empty again* on every suspend-retry: fetch → suspend → retry → fetch →
 *    forever, a hot request loop that never renders. Surviving the
 *    suspend-retry cycle is exactly what a module-level cache is for, and it is
 *    why `useAgentChat` has one (see node_modules/agents/dist/chat/react.js).
 * 2. **The permanent wedge.** The SDK's cache is keyed by the agent address and
 *    never evicts a promise that rejected during render (the evicting effect
 *    belongs to a component that never committed), so one offline load wedges
 *    the thread for the whole SPA session.
 *
 * The cache here is keyed by `${threadId}:${reloadNonce}`, so a suspend-retry
 * replays the *same* promise (render terminates) while "Try again" bumps the
 * nonce into a new key (genuinely new fetch).
 *
 * Eviction timing is the delicate part — too eager resurrects (1), never
 * resurrects (2):
 * - **Success**: evicted from a `useEffect`, i.e. only once the consuming
 *   component has *committed*. After a commit there can be no further
 *   suspend-retry for that mount, and the mount's own ref keeps the promise
 *   alive across ordinary re-renders, so nothing can observe the miss.
 * - **Failure**: evicted by `ThreadHistoryErrorBoundary` in `componentDidCatch`,
 *   which runs *after* the retry render has already re-thrown the rejection.
 *   Evicting any earlier (e.g. in a `.catch` on the promise) would make that
 *   retry render miss the cache and start a fresh failing fetch — the loop
 *   again, offline. Evicting here means a later visit to the same thread
 *   refetches instead of replaying the rejection.
 */
const historyPromises = new Map<string, Promise<unknown>>();

/** `${threadId}:${reloadNonce}` — the cache key ThreadChat suspends on. */
export function threadHistoryKey(threadId: string, reloadNonce: number): string {
  return `${threadId}:${reloadNonce}`;
}

/** Drop every cached history promise for a thread, whatever its nonce. */
export function evictThreadHistory(threadId: string): void {
  const prefix = `${threadId}:`;
  for (const key of historyPromises.keys()) {
    if (key.startsWith(prefix)) historyPromises.delete(key);
  }
}

export function useThreadHistoryPromise<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const ref = useRef<{ key: string; promise: Promise<T> } | null>(null);

  if (ref.current === null || ref.current.key !== key) {
    let promise = historyPromises.get(key) as Promise<T> | undefined;
    if (promise === undefined) {
      promise = fetcher();
      // A new nonce supersedes the old one for this thread; keep at most one
      // entry per thread so the map can't grow across retries.
      const threadId = key.slice(0, key.lastIndexOf(":"));
      evictThreadHistory(threadId);
      historyPromises.set(key, promise);
    }
    ref.current = { key, promise };
  }
  const promise = ref.current.promise;

  useEffect(() => {
    // Reached only on commit: the promise resolved, this mount holds it in its
    // ref, and no suspend-retry can need the module entry any more.
    historyPromises.delete(key);
  }, [key]);

  return promise;
}
