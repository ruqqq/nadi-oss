import { registerSW } from "virtual:pwa-register";
import { markUpdateApplied, watchForServiceWorkerUpdate } from "./sw-update-toast";

/**
 * Register the app's single service worker (src/sw.ts: shell precache + push).
 *
 * This is also the app's ONLY update mechanism — the old index.html-scraping
 * version check is gone, deliberately: a service worker is sticky, and two
 * competing "you're stale, reload" mechanisms can fight each other and wedge an
 * installed PWA. Under `registerType: "autoUpdate"` an updated worker (which
 * calls skipWaiting + clientsClaim) activates as soon as it installs, and
 * vite-plugin-pwa's registration reloads the page once it does — so a client on
 * build A lands on build B.
 *
 * That reload is silent, so sw-update-toast.ts narrates it: a toast while the
 * new worker downloads, and one on the far side of the reload.
 *
 * The browser only re-checks sw.js on navigation, so we also poll on
 * focus/visibility to catch a long-lived tab. The first update check is
 * deferred by 3s so React has time to mount and capture the URL before any
 * SW-triggered reload — this avoids losing the notification-launched route on
 * a cold start (see push-notification-thread-routing-design spec).
 */
export function installServiceWorker(): void {
  registerSW({
    immediate: true,
    // Replaces vite-plugin-pwa's own window.location.reload() on the workbox
    // "activated" event — same reload, one beat later, so the next load can
    // report the update that just landed.
    onNeedReload() {
      markUpdateApplied();
      window.location.reload();
    },
    onRegisteredSW(_url, registration) {
      if (!registration) return;
      watchForServiceWorkerUpdate(registration);
      const check = () => {
        if (document.visibilityState !== "visible" || !navigator.onLine) return;
        // Offline / transient failures are expected; the next focus retries.
        void registration.update().catch(() => {});
      };
      // Defer the initial update check to avoid a cold-start race where the SW
      // triggers a reload before React reads the notification-launched URL.
      let initialCheckDone = false;
      setTimeout(() => {
        initialCheckDone = true;
        check();
      }, 3_000);
      const onVisibilityOrFocus = () => {
        if (!initialCheckDone) return;
        check();
      };
      document.addEventListener("visibilitychange", onVisibilityOrFocus);
      window.addEventListener("focus", onVisibilityOrFocus);
    },
  });
}
