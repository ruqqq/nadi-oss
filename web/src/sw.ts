/// <reference lib="webworker" />
/**
 * The app's single service worker. It does two jobs, and it must stay the only
 * one: a ServiceWorkerRegistration owns its PushSubscription, and two workers
 * cannot share scope "/", so a second registration would silently evict the
 * first (and its push subscription with it).
 *
 * 1. Shell precache — hashed JS/CSS/fonts/icons + index.html, so an offline
 *    cold launch renders the app (which then boots read-only from the
 *    localStorage bootstrap cache) instead of the browser's error page.
 * 2. Push — the `push` / `notificationclick` handlers previously in
 *    public/push-sw.js, ported and then rewritten to use postMessage for
 *    soft in-app navigation (see push-notification-thread-routing-design spec).
 *
 * SHELL ONLY. Nothing under /api, /agents, /think-agents, /live is ever cached
 * or served from cache; no non-GET request is ever touched. A cached mutation
 * or a cached WebSocket upgrade would be a serious bug, and thread/message data
 * is deliberately out of scope. Everything below is either precache (static,
 * content-hashed, revisioned by the build) or an explicit pass-through.
 */
import { clientsClaim } from "workbox-core";
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
  type PrecacheEntry,
} from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { handleNotificationClick } from "./lib/notification-click";
import { savePendingThreadNavigation } from "./lib/pending-navigation";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: (PrecacheEntry | string)[];
};

// The service worker is the app's single update mechanism (there is no
// version-check.ts anymore), so a new build must take over immediately rather
// than wait for every tab to close: activate at once and claim open clients.
// The client-side registration (main.tsx) reloads the page once the updated
// worker activates.
self.skipWaiting();
clientsClaim();

// Precache the built shell. Workbox registers a GET route per precached URL and
// nothing else — any request that doesn't match (all of /api, /agents,
// /think-agents, /live, every non-GET) falls through to the network untouched.
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

/**
 * Requests that must never be answered with the app shell. A navigation to any
 * of these goes to the network (or fails offline, which is correct — serving
 * index.html in place of an API response would look like stale data).
 */
const NAVIGATION_DENYLIST = [
  /^\/api\//,
  /^\/agents\//,
  /^\/think-agents\//,
  /^\/live$/,
  // The no-backend visual QA harness is its own document; never shadow it with
  // the app shell.
  /^\/preview\.html$/,
  // Same for the mocked-app harness (dev-only document, MSW-backed).
  /^\/mock\.html$/,
];

// Offline navigations (/, /threads/:id, /settings, …) get the precached
// index.html. `createHandlerBoundToURL` resolves through the precache, so it
// serves the revision the currently active worker installed.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL("/index.html"), {
    denylist: NAVIGATION_DENYLIST,
  }),
);

// --- Push ---------------------------------------------------------------

interface PushPayload {
  title?: unknown;
  body?: unknown;
  url?: unknown;
}

self.addEventListener("push", (event) => {
  let payload: PushPayload = {};
  try {
    payload = event.data ? (event.data.json() as PushPayload) : {};
  } catch {
    payload = {};
  }
  const title = typeof payload.title === "string" ? payload.title : "Nadi";
  const body = typeof payload.body === "string" ? payload.body : "Open Nadi to continue.";
  const url = typeof payload.url === "string" ? payload.url : "/";
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      data: { url },
      tag: url,
    }),
  );
});

/**
 * Notification click handler.
 *
 * Instead of forcing a full page reload via client.navigate(), this records the
 * target thread durably (pending-navigation.ts), then sends a postMessage to
 * all open clients so the React app can perform a soft SPA navigation, falling
 * back to openWindow() only when no clients exist.
 *
 * The record is the load-bearing part: a tap restores the installed PWA at
 * start_url ("/") before this runs, so there is usually a client to message but
 * it may still be booting — and a message the page is not yet listening for is
 * dropped, which is how a tap used to land on the chat list. The page claims
 * the record on mount and on resume instead.
 *
 * Which is why `matchAll` is passed as a thunk and NOT awaited here. Awaiting it
 * before calling the handler put a second, unrelated await ahead of the record,
 * so a slow or stalled client lookup could cost the tap entirely — no record
 * written, nobody messaged, nothing for the page to find on the next resume.
 *
 * NOTE: none of this runs on an installed iOS PWA that is already open. WebKit
 * does not fire `notificationclick` at all when the app is running and was
 * launched from the home-screen icon rather than by a notification (unfixed as
 * of iOS 17.4), so a foreground tap is unreachable from here no matter what
 * this handler does. Reaching that case at all means hanging off `push`, which
 * does fire.
 *
 * See: push-notification-thread-routing-design spec, and lib/notification-click.ts
 * for the decision itself (tested there).
 */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data as { url?: unknown } | null;
  const rawUrl = data && typeof data.url === "string" ? data.url : "/";

  event.waitUntil(
    handleNotificationClick(rawUrl, {
      getClients: async () =>
        (await self.clients.matchAll({ type: "window", includeUncontrolled: true })).filter(
          (client) => "focus" in client,
        ),
      openWindow: (url) => self.clients.openWindow(url),
      savePending: (threadId) => savePendingThreadNavigation(threadId),
      origin: self.location.origin,
    }),
  );
});
