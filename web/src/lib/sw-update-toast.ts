import { toast } from "sonner";

const TOAST_ID = "sw-update";
const APPLIED_KEY = "nadi:sw-update-applied";

/**
 * Report a service worker update to the user, across the reload that applies it.
 *
 * The app auto-updates (see register-sw.ts): a new worker installs, activates,
 * and the page reloads onto it with no prompt. That reload is the only thing the
 * user actually sees, so it reads as a crash unless we name it. The download
 * toast covers the install (only visible on a slow connection); the flag carries
 * the news across the reload that destroys it.
 */

/** Show "Downloading update…" while a new worker installs over the current one. */
export function watchForServiceWorkerUpdate(registration: ServiceWorkerRegistration): void {
  registration.addEventListener("updatefound", () => {
    // No active worker means this is the first-ever install, not an update:
    // there is no previous version and nothing to explain.
    if (!registration.active) return;
    const installing = registration.installing;
    if (!installing) return;
    toast.loading("Downloading update…", { id: TOAST_ID });
    installing.addEventListener("statechange", () => {
      // Install failed. Stay quiet — a failed background update is not the
      // user's problem, and the next focus check retries it.
      if (installing.state === "redundant") toast.dismiss(TOAST_ID);
    });
  });
}

/**
 * Record that an update is about to be applied, for the next page load to
 * report. Called in place of vite-plugin-pwa's reload, immediately before it.
 */
export function markUpdateApplied(storage: Storage = sessionStorage): void {
  try {
    storage.setItem(APPLIED_KEY, "1");
  } catch {
    // Storage can throw (Safari private mode). The update still applies; we
    // just lose the confirmation.
  }
}

/**
 * On boot, report an update applied by the previous load. Consuming the flag
 * makes this idempotent, so a repeat call (StrictMode) can't double-toast.
 *
 * Must run after <AppToaster /> has mounted: sonner publishes only to
 * subscribers present at the time, and drops toasts fired before the Toaster
 * subscribes.
 */
export function showAppliedUpdateToast(storage: Storage = sessionStorage): void {
  let applied = false;
  try {
    applied = storage.getItem(APPLIED_KEY) === "1";
    if (applied) storage.removeItem(APPLIED_KEY);
  } catch {
    return;
  }
  if (applied) toast.success("Updated to the latest version");
}
