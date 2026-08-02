import { afterEach, describe, expect, it, vi } from "vitest";
import {
  browserNotificationStatusText,
  classifyBrowserNotificationSupport,
  recoverPushSubscription,
  urlBase64ToUint8Array,
} from "./browser-notifications";

describe("browser notifications", () => {
  it("decodes VAPID public keys", () => {
    expect(urlBase64ToUint8Array("AQID")).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("classifies missing APIs as unsupported", () => {
    expect(classifyBrowserNotificationSupport({})).toMatchObject({ supported: false });
  });

  it("classifies complete push APIs as supported", () => {
    expect(
      classifyBrowserNotificationSupport({
        Notification: { permission: "granted" },
        navigator: { serviceWorker: {} },
        PushManager: function PushManager() {},
      }),
    ).toMatchObject({ supported: true });
  });

  it("describes unsupported iOS browsers that are not installed", () => {
    expect(
      browserNotificationStatusText(
        { supported: false, reason: "ios_not_installed", standalone: false },
        false,
      ),
    ).toBe("Add Nadi to your Home Screen to enable browser notifications on this device.");
  });

  it("describes unsupported browsers", () => {
    expect(
      browserNotificationStatusText(
        { supported: false, reason: "missing_api", standalone: false },
        false,
      ),
    ).toBe("Browser notifications are not supported in this browser.");
  });

  it("describes blocked notification permission", () => {
    expect(
      browserNotificationStatusText(
        { supported: true, permission: "denied", standalone: false },
        false,
      ),
    ).toBe("Notifications are blocked in this browser.");
  });

  it("describes enabled browser notifications", () => {
    expect(
      browserNotificationStatusText(
        { supported: true, permission: "granted", standalone: false },
        true,
        true,
      ),
    ).toBe("Browser notifications are enabled for this browser.");
  });

  it("describes account-enabled notifications without this browser subscribed", () => {
    expect(
      browserNotificationStatusText(
        { supported: true, permission: "granted", standalone: false },
        true,
        false,
      ),
    ).toBe(
      "Browser notifications are enabled for your account. Subscribe this browser to receive them here.",
    );
  });

  it("describes disabled browser notifications", () => {
    expect(
      browserNotificationStatusText(
        { supported: true, permission: "default", standalone: false },
        false,
      ),
    ).toBe("Browser notifications are off.");
  });
});

/** Moving push from the old standalone /push-sw.js onto the app's single
 *  service worker drops the subscription that belonged to the old registration.
 *  Recovery must re-subscribe silently — and only where the browser had already
 *  granted permission, so it can never surface a prompt out of nowhere. */
describe("recoverPushSubscription", () => {
  const VAPID = "AQID";

  function stubBrowser(options: {
    permission: NotificationPermission;
    existing: unknown;
    subscribe: ReturnType<typeof vi.fn>;
  }) {
    const registration = {
      pushManager: {
        getSubscription: vi.fn().mockResolvedValue(options.existing),
        subscribe: options.subscribe,
      },
    };
    vi.stubGlobal("Notification", { permission: options.permission });
    vi.stubGlobal("PushManager", class {});
    vi.stubGlobal("navigator", {
      serviceWorker: {
        getRegistration: vi.fn().mockResolvedValue(registration),
        ready: Promise.resolve(registration),
      },
    });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("re-subscribes when permission is granted but the subscription is gone", async () => {
    const json = { endpoint: "https://push.example/new" };
    const subscribe = vi.fn().mockResolvedValue({ toJSON: () => json });
    stubBrowser({ permission: "granted", existing: null, subscribe });

    await expect(recoverPushSubscription(VAPID)).resolves.toEqual(json);
    expect(subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
  });

  it("does nothing when the registration still has a subscription", async () => {
    const subscribe = vi.fn();
    stubBrowser({
      permission: "granted",
      existing: { toJSON: () => ({ endpoint: "https://push.example/old" }) },
      subscribe,
    });

    await expect(recoverPushSubscription(VAPID)).resolves.toBeNull();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("never subscribes in a browser that has not granted permission", async () => {
    const subscribe = vi.fn();
    stubBrowser({ permission: "default", existing: null, subscribe });

    await expect(recoverPushSubscription(VAPID)).resolves.toBeNull();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("returns null instead of throwing when subscribing fails", async () => {
    const subscribe = vi.fn().mockRejectedValue(new Error("push service unavailable"));
    stubBrowser({ permission: "granted", existing: null, subscribe });

    await expect(recoverPushSubscription(VAPID)).resolves.toBeNull();
  });
});
