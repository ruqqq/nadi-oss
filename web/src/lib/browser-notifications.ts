export type BrowserNotificationSupport =
  | { supported: true; permission: NotificationPermission; standalone: boolean }
  | { supported: false; reason: "missing_api" | "ios_not_installed"; standalone: boolean };

export function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    bytes[i] = raw.charCodeAt(i);
  }
  return bytes;
}

export function isStandaloneDisplay(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}

export function classifyBrowserNotificationSupport(global: {
  Notification?: unknown;
  navigator?: unknown;
  PushManager?: unknown;
}): BrowserNotificationSupport {
  const standalone =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    isStandaloneDisplay();
  const nav = global.navigator as { serviceWorker?: unknown; userAgent?: string } | undefined;
  const notificationApi = global.Notification as
    | { permission?: NotificationPermission }
    | undefined;
  const hasApis = Boolean(notificationApi && global.PushManager && nav?.serviceWorker);
  if (!hasApis) {
    const ua = nav?.userAgent ?? "";
    if (/iPad|iPhone|iPod/.test(ua) && !standalone) {
      return { supported: false, reason: "ios_not_installed", standalone };
    }
    return { supported: false, reason: "missing_api", standalone };
  }
  // Read the live permission from the passed API object; fall back to the real
  // global (and finally "default") so callers that stub the API still work.
  const permission =
    notificationApi?.permission ??
    (typeof Notification === "undefined" ? "default" : Notification.permission);
  return { supported: true, permission, standalone };
}

/** Human-readable status copy for the current support/permission state. */
export function browserNotificationStatusText(
  support: BrowserNotificationSupport,
  enabled: boolean,
  deviceSubscribed = enabled,
): string {
  if (!support.supported && support.reason === "ios_not_installed") {
    return "Add Nadi to your Home Screen to enable browser notifications on this device.";
  }
  if (!support.supported) return "Browser notifications are not supported in this browser.";
  if (support.permission === "denied") return "Notifications are blocked in this browser.";
  if (enabled && !deviceSubscribed) {
    return "Browser notifications are enabled for your account. Subscribe this browser to receive them here.";
  }
  if (enabled) return "Browser notifications are enabled for this browser.";
  return "Browser notifications are off.";
}

const SW_WAIT_MS = 5_000;

/**
 * The app's one service worker registration (src/sw.ts — shell precache AND
 * push; see the note there on why it must stay one). It is registered at
 * startup by lib/register-sw.ts, so this only has to find it — never register a
 * second worker at scope "/", which would evict this one and its
 * PushSubscription with it.
 *
 * `navigator.serviceWorker.ready` never settles when no worker is registered
 * (the dev server, an unsupported browser), so it is raced against a timeout
 * rather than awaited bare.
 */
async function appServiceWorkerRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  const existing = await navigator.serviceWorker.getRegistration();
  if (existing) return existing;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), SW_WAIT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function getExistingPushSubscription(): Promise<PushSubscriptionJSON | null> {
  if (!("serviceWorker" in navigator) || typeof PushManager === "undefined") return null;

  try {
    const registration = await appServiceWorkerRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    return subscription?.toJSON() ?? null;
  } catch {
    return null;
  }
}

/**
 * Request permission and subscribe on the app's service worker (reusing any
 * existing subscription). Returns the serialized subscription for the server.
 * Throws if the browser lacks the APIs or permission is not granted.
 */
export async function ensurePushSubscription(
  vapidPublicKey: string,
): Promise<PushSubscriptionJSON> {
  if (
    typeof Notification === "undefined" ||
    !("serviceWorker" in navigator) ||
    typeof PushManager === "undefined"
  ) {
    throw new Error("Push notifications are not supported in this browser.");
  }
  const registration = await appServiceWorkerRegistration();
  if (!registration) {
    throw new Error("The Nadi service worker is not available in this browser yet.");
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notification permission was not granted.");
  }
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    }));
  return subscription.toJSON();
}

/**
 * Migration recovery. A PushSubscription belongs to the ServiceWorkerRegistration
 * that created it, and this app used to subscribe on a separate `/push-sw.js`
 * worker. Replacing it with the single app worker drops that subscription, so
 * devices that already had push would go silent with no visible failure.
 *
 * Recover it silently: if this browser has already granted notification
 * permission (i.e. it went through the enable flow at some point) and the
 * account has browser push on, but the current registration has no
 * subscription, subscribe again. Returns the new subscription for the caller to
 * POST to /api/notifications/browser/subscriptions, or null when there is
 * nothing to recover. Never prompts — `requestPermission` is not called, and a
 * browser that never granted permission is left untouched.
 */
export async function recoverPushSubscription(
  vapidPublicKey: string,
): Promise<PushSubscriptionJSON | null> {
  if (
    typeof Notification === "undefined" ||
    !("serviceWorker" in navigator) ||
    typeof PushManager === "undefined"
  ) {
    return null;
  }
  if (Notification.permission !== "granted") return null;
  try {
    const registration = await appServiceWorkerRegistration();
    if (!registration) return null;
    if (await registration.pushManager.getSubscription()) return null; // Still subscribed.
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    });
    return subscription.toJSON();
  } catch {
    return null; // Best-effort; the user can always re-enable in Settings.
  }
}
