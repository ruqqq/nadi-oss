import { describe, expect, it, vi } from "vitest";
import {
  isWebPushConfigured,
  sendWebPush,
  sendWebPushWithEcdh,
} from "../../../src/notifications/web-push";
import { p256 } from "@noble/curves/p256";

vi.mock("web-push-neo", () => ({
  sendNotification: vi.fn(async () => ({
    statusCode: 201,
    headers: {},
    body: "",
  })),
}));

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** Native WebCrypto RFC 8291 decryption — the oracle for the celld shim. */
async function decryptAes128Gcm(
  body: Uint8Array<ArrayBuffer>,
  subscriberPrivate: Uint8Array,
  authSecret: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const salt = body.slice(0, 16);
  const keyIdLength = body[20]!;
  const ephemeralPublic = body.slice(21, 21 + keyIdLength);
  const ciphertext = body.slice(21 + keyIdLength);
  const subscriberPublic = p256.getPublicKey(subscriberPrivate, false);

  const privateJwk = {
    kty: "EC",
    crv: "P-256",
    x: bytesToBase64Url(subscriberPublic.slice(1, 33)),
    y: bytesToBase64Url(subscriberPublic.slice(33, 65)),
    d: bytesToBase64Url(subscriberPrivate),
  } as JsonWebKey;
  const subscriberKey = await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const ephemeralKey = await crypto.subtle.importKey(
    "raw",
    ephemeralPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: ephemeralKey }, subscriberKey, 256),
  );

  const ikm = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: authSecret,
        info: concatBytes(textEncoder.encode("WebPush: info\0"), subscriberPublic, ephemeralPublic),
      },
      await crypto.subtle.importKey("raw", sharedSecret, "HKDF", false, ["deriveBits"]),
      32 * 8,
    ),
  );
  const ikmKey = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const contentEncryptionKey = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt,
        info: textEncoder.encode("Content-Encoding: aes128gcm\0"),
      },
      ikmKey,
      16 * 8,
    ),
  );
  const nonce = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt,
        info: textEncoder.encode("Content-Encoding: nonce\0"),
      },
      ikmKey,
      12 * 8,
    ),
  );

  const aesKey = await crypto.subtle.importKey(
    "raw",
    contentEncryptionKey,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const padded = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aesKey, ciphertext),
  );
  return textDecoder.decode(padded.slice(0, -1));
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(arrays.reduce((total, array) => total + array.length, 0));
  let offset = 0;
  for (const array of arrays) {
    out.set(array, offset);
    offset += array.length;
  }
  return out;
}

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

  it("encrypts and POSTs via the celld shim when native ECDH is unavailable", async () => {
    const subscriberPrivate = new Uint8Array(32).fill(0x41);
    const subscriberPublic = p256.getPublicKey(subscriberPrivate, false);
    const authSecret = new Uint8Array(16).fill(0x42);
    const vapidPrivate = new Uint8Array(32).fill(0x51);
    const vapidPublic = p256.getPublicKey(vapidPrivate, false);

    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("ok", { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const payload = { title: "Nadi", body: "celld path", url: "/threads/t1" };
      await expect(
        sendWebPushWithEcdh(
          {
            env: {
              VAPID_PUBLIC_KEY: bytesToBase64Url(vapidPublic),
              VAPID_PRIVATE_KEY: bytesToBase64Url(vapidPrivate),
              VAPID_SUBJECT: "mailto:test@example.com",
            },
            subscription: {
              endpoint: "https://push.example/sub",
              p256dh: bytesToBase64Url(subscriberPublic),
              auth: bytesToBase64Url(authSecret),
            },
            payload,
          },
          false,
        ),
      ).resolves.toBe("sent");
    } finally {
      vi.unstubAllGlobals();
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://push.example/sub");
    expect(init?.method).toBe("POST");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers["Content-Encoding"]).toBe("aes128gcm");
    expect(headers["Authorization"]).toMatch(/^vapid t=[^,]+,k=/);
    const body = new Uint8Array(init?.body as ArrayBuffer);
    await expect(decryptAes128Gcm(body, subscriberPrivate, authSecret)).resolves.toBe(
      JSON.stringify({ title: "Nadi", body: "celld path", url: "/threads/t1" }),
    );
  });

  it("maps terminal provider responses to gone on the celld shim", async () => {
    const subscriberPrivate = new Uint8Array(32).fill(0x41);
    const subscriberPublic = p256.getPublicKey(subscriberPrivate, false);
    const authSecret = new Uint8Array(16).fill(0x42);
    const vapidPrivate = new Uint8Array(32).fill(0x51);
    const vapidPublic = p256.getPublicKey(vapidPrivate, false);

    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response("gone", { status: 410 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(
        sendWebPushWithEcdh(
          {
            env: {
              VAPID_PUBLIC_KEY: bytesToBase64Url(vapidPublic),
              VAPID_PRIVATE_KEY: bytesToBase64Url(vapidPrivate),
              VAPID_SUBJECT: "mailto:test@example.com",
            },
            subscription: {
              endpoint: "https://push.example/sub",
              p256dh: bytesToBase64Url(subscriberPublic),
              auth: bytesToBase64Url(authSecret),
            },
            payload: { title: "Nadi", body: "gone", url: "/threads/t1" },
          },
          false,
        ),
      ).resolves.toBe("gone");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
