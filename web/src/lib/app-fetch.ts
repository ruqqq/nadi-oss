import { OfflineError, networkIsOnline } from "./offline-state";

/** GET/HEAD are reads; everything else changes server state. */
function isRead(method: string): boolean {
  const normalized = method.toUpperCase();
  return normalized === "GET" || normalized === "HEAD";
}

function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method;
  if (input instanceof Request) return input.method;
  return "GET";
}

/**
 * The app's default fetch. Reads pass through always (they may be served from a
 * cache, and failing them offline would break the read-only experience we're
 * trying to give). Mutations fail fast with a human-readable OfflineError rather
 * than a raw `TypeError: Failed to fetch`.
 *
 * This is the structural guarantee behind "read-only offline" — every API module
 * defaults its `fetchImpl` to this.
 */
export const appFetch: typeof fetch = (input, init) => {
  if (!networkIsOnline() && !isRead(methodOf(input, init))) {
    return Promise.reject(new OfflineError());
  }
  return fetch(input, init);
};
