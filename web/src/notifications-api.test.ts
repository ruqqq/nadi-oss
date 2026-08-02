import { describe, expect, it, vi } from "vitest";
import {
  getBrowserNotifications,
  saveBrowserPushSubscription,
  updateBrowserNotificationSettings,
} from "./notifications-api";

describe("notifications api", () => {
  it("loads browser notification settings", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ browserPushEnabled: false, vapidPublicKey: null }),
    );

    await expect(getBrowserNotifications(fetchImpl as typeof fetch)).resolves.toMatchObject({
      browserPushEnabled: false,
      vapidPublicKey: null,
    });
  });

  it("saves browser notification settings", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ browserPushEnabled: true, pushPreviewEnabled: true, vapidPublicKey: "pub" }),
    );

    await updateBrowserNotificationSettings({ browserPushEnabled: true }, fetchImpl as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/notifications/browser/settings",
      expect.objectContaining({ method: "PUT", credentials: "include" }),
    );
  });

  // Each switch owns one field. Sending both would let the preview toggle
  // resubmit a stale value for the push toggle, and vice versa.
  it("sends only the field being changed", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ browserPushEnabled: true, pushPreviewEnabled: false, vapidPublicKey: null }),
    );

    await updateBrowserNotificationSettings(
      { pushPreviewEnabled: false },
      fetchImpl as typeof fetch,
    );

    const init = (fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>)[0]![1];
    expect(JSON.parse(init.body as string)).toEqual({ pushPreviewEnabled: false });
  });

  it("reads the preview setting back", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ browserPushEnabled: true, pushPreviewEnabled: false, vapidPublicKey: null }),
    );

    await expect(getBrowserNotifications(fetchImpl as typeof fetch)).resolves.toMatchObject({
      pushPreviewEnabled: false,
    });
  });

  it("saves a browser push subscription", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));

    await expect(
      saveBrowserPushSubscription(
        {
          endpoint: "https://push.example/subscription",
          keys: {
            p256dh: "p256dh",
            auth: "auth",
          },
        },
        fetchImpl as typeof fetch,
      ),
    ).resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/notifications/browser/subscriptions",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
      }),
    );
  });
});
