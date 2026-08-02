/**
 * Recovery from a stale bundle.
 *
 * A deploy replaces the hashed asset files, so a tab still running the previous
 * build asks for chunks that are gone. Cloudflare serves this app with
 * `not_found_handling: "single-page-application"`, so those requests come back
 * as index.html with a 200 — the dynamic import then fails on the MIME type
 * rather than a clean 404. Whatever the wording, the user sees a lie: the
 * lazily-loaded ChatLog chunk failing reads as "Couldn't load this
 * conversation", and its Try again re-imports the same dead URL forever.
 *
 * The fix is to get the new bundle. Note that a plain reload does NOT do that:
 * sw.ts answers navigations from the precache (createHandlerBoundToURL), so the
 * active worker hands back the same index.html and the same dead chunk URLs. We
 * have to update the worker first — an updated worker calls skipWaiting +
 * clientsClaim, which fires vite-plugin-pwa's `activated` hook, which is
 * register-sw.ts's onNeedReload: markUpdateApplied() then reload. So the user
 * lands on the new build and reads "Updated to the latest version".
 *
 * If no update is found, the failure was something else (a network blip, an
 * asset that is genuinely missing) and we fall back to one plain reload,
 * silently. A `sessionStorage` stamp caps this at one attempt per minute so a
 * reload that doesn't help can't become a reload loop.
 */

const STAMP_KEY = "nadi:stale-bundle-recovery";
const RECOVERY_WINDOW_MS = 60_000;
const UPDATE_WAIT_MS = 5_000;

/** Substrings, lowercased, of how each engine reports a failed module load. */
const CHUNK_ERROR_SIGNATURES = [
  // Chrome / Edge
  "failed to fetch dynamically imported module",
  // Firefox
  "error loading dynamically imported module",
  // Safari
  "importing a module script failed",
  // The Cloudflare SPA fallback: a missing chunk answered with index.html.
  "expected a javascript module script",
  // Vite's CSS preload helper.
  "unable to preload css",
];

export function isChunkLoadError(error: unknown): boolean {
  if (typeof error === "string") return matches(error);
  if (!(error instanceof Error)) {
    // Not an Error, but message-shaped (some engines surface a plain object).
    const message = (error as { message?: unknown } | null)?.message;
    return typeof message === "string" && matches(message);
  }
  if (error.name === "ChunkLoadError") return true;
  return matches(error.message);
}

function matches(message: string): boolean {
  const lowered = message.toLowerCase();
  return CHUNK_ERROR_SIGNATURES.some((signature) => lowered.includes(signature));
}

export type StaleBundleOutcome = "recovering" | "gave-up";

export interface StaleBundleDeps {
  storage?: Storage;
  now?: () => number;
  reload?: () => void;
  getRegistration?: () => Promise<ServiceWorkerRegistration | null>;
  wait?: (ms: number) => Promise<void>;
  /** Skip the once-a-minute cap — the user asked for this reload by hand. */
  force?: boolean;
}

// Every failed chunk in a burst (a route can pull several) must lead to one
// recovery, not one per import.
let inFlight: Promise<StaleBundleOutcome> | null = null;

export function recoverFromStaleBundle(deps: StaleBundleDeps = {}): Promise<StaleBundleOutcome> {
  inFlight ??= run(deps).finally(() => {
    // Cleared even on the reloading path: the navigation is what actually ends
    // this, and if it somehow doesn't happen the stamp still caps retries.
    inFlight = null;
  });
  return inFlight;
}

async function run({
  storage = sessionStorage,
  now = () => Date.now(),
  reload = () => window.location.reload(),
  getRegistration = defaultGetRegistration,
  wait = defaultWait,
  force = false,
}: StaleBundleDeps): Promise<StaleBundleOutcome> {
  const at = now();
  if (!force && attemptedRecently(storage, at)) return "gave-up";
  stamp(storage, at);

  const registration = await getRegistration();
  if (!registration) {
    // No worker in the way: the reload goes to the network, which is the whole
    // recovery.
    reload();
    return "recovering";
  }

  // Offline or a failed fetch of sw.js is expected here; the reload below is
  // still the right next move.
  await registration.update().catch(() => {});
  await wait(UPDATE_WAIT_MS);
  // Reached only when no updated worker activated — onNeedReload would have
  // reloaded (and toasted) already. Silent: nothing was updated.
  reload();
  return "recovering";
}

function attemptedRecently(storage: Storage, at: number): boolean {
  const raw = read(storage);
  if (raw === null) return false;
  const previous = Number(raw);
  return Number.isFinite(previous) && at - previous < RECOVERY_WINDOW_MS;
}

function read(storage: Storage): string | null {
  try {
    return storage.getItem(STAMP_KEY);
  } catch {
    // Storage can throw (Safari private mode). Without it we lose loop
    // protection, not the recovery — treat it as "no previous attempt".
    return null;
  }
}

function stamp(storage: Storage, at: number): void {
  try {
    storage.setItem(STAMP_KEY, String(at));
  } catch {
    // See read().
  }
}

function defaultGetRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return Promise.resolve(null);
  }
  return navigator.serviceWorker.getRegistration().then((r) => r ?? null).catch(() => null);
}

function defaultWait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Listen for the chunk failures that never reach a React error boundary: a
 * preload rejection Vite reports itself, and an import that fails outside
 * render. Returns a teardown for tests.
 */
export function installStaleBundleRecovery({
  target = window,
  recover = () => recoverFromStaleBundle(),
}: {
  target?: Window;
  recover?: () => Promise<StaleBundleOutcome>;
} = {}): () => void {
  const onPreloadError = (event: Event) => {
    // Vite rethrows this into the page unless it is cancelled, and we are
    // already handling it.
    event.preventDefault();
    void recover();
  };
  const onError = (event: Event) => {
    const error = (event as ErrorEvent).error ?? (event as ErrorEvent).message;
    if (isChunkLoadError(error)) void recover();
  };
  const onRejection = (event: Event) => {
    if (isChunkLoadError((event as PromiseRejectionEvent).reason)) void recover();
  };

  target.addEventListener("vite:preloadError", onPreloadError);
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);

  return () => {
    target.removeEventListener("vite:preloadError", onPreloadError);
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}
