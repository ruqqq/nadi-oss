import { appFetch } from "./lib/app-fetch";
import { errorFromResponse } from "./lib/http-error";

type FetchLike = typeof fetch;

export interface BrowserNotificationsResponse {
  browserPushEnabled: boolean;
  /** Whether push bodies carry the start of Nadi's reply. */
  pushPreviewEnabled: boolean;
  vapidPublicKey: string | null;
}

export interface BrowserNotificationSettingsPatch {
  browserPushEnabled?: boolean;
  pushPreviewEnabled?: boolean;
}

export async function getBrowserNotifications(
  fetchImpl: FetchLike = appFetch,
): Promise<BrowserNotificationsResponse> {
  const res = await fetchImpl("/api/notifications/browser", {
    credentials: "include",
  });
  if (!res.ok) {
    throw await errorFromResponse(res, "load browser notification settings");
  }
  return (await res.json()) as BrowserNotificationsResponse;
}

/** Send only the field being changed; the server leaves the others alone. */
export async function updateBrowserNotificationSettings(
  patch: BrowserNotificationSettingsPatch,
  fetchImpl: FetchLike = appFetch,
): Promise<BrowserNotificationsResponse> {
  const res = await fetchImpl("/api/notifications/browser/settings", {
    method: "PUT",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    throw await errorFromResponse(res, "save browser notification settings");
  }
  return (await res.json()) as BrowserNotificationsResponse;
}

export async function saveBrowserPushSubscription(
  subscription: PushSubscriptionJSON,
  fetchImpl: FetchLike = appFetch,
): Promise<void> {
  const res = await fetchImpl("/api/notifications/browser/subscriptions", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(subscription),
  });
  if (!res.ok) {
    throw await errorFromResponse(res, "save this browser notification subscription");
  }
}
