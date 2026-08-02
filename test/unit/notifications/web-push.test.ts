import { describe, expect, it, vi } from "vitest";
import { isWebPushConfigured, sendWebPush } from "../../../src/notifications/web-push";

vi.mock("web-push-neo", () => ({
  sendNotification: vi.fn(async () => ({
    statusCode: 201,
    headers: {},
    body: "",
  })),
}));

describe("web push", () => {
  it("reports disabled when VAPID config is absent", () => {
    expect(isWebPushConfigured({})).toBe(false);
  });

  it("returns disabled without sending when config is missing", async () => {
    const { sendNotification } = await import("web-push-neo");

    await expect(
      sendWebPush({
        env: {},
        subscription: {
          endpoint: "https://push.example/sub",
          p256dh: "key",
          auth: "auth",
        },
        payload: { title: "Nadi", body: "Open the thread.", url: "/threads/t1" },
      }),
    ).resolves.toBe("disabled");

    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("maps terminal provider responses to gone", async () => {
    const { sendNotification } = await import("web-push-neo");
    vi.mocked(sendNotification).mockRejectedValueOnce({ statusCode: 410 });

    await expect(
      sendWebPush({
        env: {
          VAPID_PUBLIC_KEY: "pub",
          VAPID_PRIVATE_KEY: "priv",
          VAPID_SUBJECT: "mailto:test@example.com",
        },
        subscription: {
          endpoint: "https://push.example/sub",
          p256dh: "key",
          auth: "auth",
        },
        payload: { title: "Nadi", body: "Open the thread.", url: "/threads/t1" },
      }),
    ).resolves.toBe("gone");
  });

  it("sends privacy-safe JSON payloads with VAPID details", async () => {
    const { sendNotification } = await import("web-push-neo");

    await expect(
      sendWebPush({
        env: {
          VAPID_PUBLIC_KEY: "pub",
          VAPID_PRIVATE_KEY: "priv",
          VAPID_SUBJECT: "mailto:test@example.com",
        },
        subscription: {
          endpoint: "https://push.example/sub",
          p256dh: "key",
          auth: "auth",
        },
        payload: {
          title: "Nadi finished responding",
          body: "Open the thread to review the update.",
          url: "/threads/t1",
        },
      }),
    ).resolves.toBe("sent");

    expect(sendNotification).toHaveBeenCalledWith(
      { endpoint: "https://push.example/sub", keys: { p256dh: "key", auth: "auth" } },
      JSON.stringify({
        title: "Nadi finished responding",
        body: "Open the thread to review the update.",
        url: "/threads/t1",
      }),
      expect.objectContaining({
        TTL: 300,
        urgency: "normal",
        vapidDetails: {
          subject: "mailto:test@example.com",
          publicKey: "pub",
          privateKey: "priv",
        },
      }),
    );
    expect(vi.mocked(sendNotification).mock.calls[0]?.[2]).not.toHaveProperty("topic");
  });
});
