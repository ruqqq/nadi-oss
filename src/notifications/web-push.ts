import { sendNotification, type PushSubscription } from "web-push-neo";

import { encryptPayloadAes128Gcm } from "./push-encryption";
import { base64UrlToBytes, bytesToBase64Url } from "../encoding";

type PushEnv = {
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
};

export interface PushSubscriptionLike {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushPayload {
  title: string;
  body: string;
  url: string;
}

interface SendWebPushInput {
  env: PushEnv;
  subscription: PushSubscriptionLike;
  payload: PushPayload;
}

export function isWebPushConfigured(env: PushEnv): boolean {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);
}

/**
 * Capability probe: does this runtime's native WebCrypto support ECDH?
 * web-push-neo encrypts payloads with native ECDH, which celld's WebCrypto
 * lacks. Choosing by capability rather than platform means a future celld that
 * gains ECDH silently stops using the shim. The result is memoized per isolate.
 *
 * It probes the WHOLE derivation, and that is load-bearing rather than
 * thorough-for-its-own-sake: on celld 0.2.0 `generateKey` and a PKCS#8 import
 * both succeed, and only the `raw` public import fails (`NotSupportedError:
 * unsupported key import`). A probe that stopped at either earlier step would
 * report native support and then throw mid-encryption. (The RS256 probe in
 * `github/jwt.ts` learned this the hard way — see the note there.)
 */
let nativeEcdhCached: boolean | undefined;

export async function nativeEcdhAvailable(): Promise<boolean> {
  if (nativeEcdhCached !== undefined) {
    return nativeEcdhCached;
  }
  try {
    const keyPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ]);
    const rawPublic = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
    const importedPublic = await crypto.subtle.importKey(
      "raw",
      rawPublic,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: importedPublic },
      keyPair.privateKey,
      256,
    );
    nativeEcdhCached = true;
  } catch {
    nativeEcdhCached = false;
  }
  return nativeEcdhCached;
}

export async function sendWebPush(
  input: SendWebPushInput,
): Promise<"sent" | "gone" | "failed" | "disabled"> {
  return sendWebPushWithEcdh(input, await nativeEcdhAvailable());
}

/**
 * Test seam: run the exact platform path for a forced capability result, so
 * the celld fallback can be exercised where native ECDH actually exists.
 * Production callers use {@link sendWebPush}, which probes.
 */
export async function sendWebPushWithEcdh(
  input: SendWebPushInput,
  nativeEcdh: boolean,
): Promise<"sent" | "gone" | "failed" | "disabled"> {
  if (!isWebPushConfigured(input.env)) {
    return "disabled";
  }

  try {
    if (nativeEcdh) {
      const subscription: PushSubscription = {
        endpoint: input.subscription.endpoint,
        keys: {
          p256dh: input.subscription.p256dh,
          auth: input.subscription.auth,
        },
      };
      await sendNotification(subscription, JSON.stringify(input.payload), {
        vapidDetails: {
          subject: input.env.VAPID_SUBJECT!,
          publicKey: input.env.VAPID_PUBLIC_KEY!,
          privateKey: input.env.VAPID_PRIVATE_KEY!,
        },
        TTL: 300,
        urgency: "normal",
      });
    } else {
      await sendViaCelldShim(input);
    }
    return "sent";
  } catch (error) {
    const statusCode =
      typeof error === "object" && error !== null
        ? (error as { statusCode?: unknown }).statusCode
        : undefined;
    if (statusCode === 404 || statusCode === 410) {
      return "gone";
    }
    return "failed";
  }
}

/**
 * The celld path: web-push-neo is unusable there because payload encryption
 * needs native ECDH, so encrypt in-repo (@noble/curves + @noble/hashes +
 * native AES-GCM) and replicate web-push-neo's request shape (RFC 8291 body,
 * ES256 VAPID JWT signed with native ECDSA, same headers).
 */
async function sendViaCelldShim(input: SendWebPushInput): Promise<void> {
  const { endpoint, p256dh, auth } = input.subscription;
  validateSubscription(input.subscription);

  const body = await encryptPayloadAes128Gcm(
    new TextEncoder().encode(JSON.stringify(input.payload)),
    base64UrlToBytes(p256dh),
    base64UrlToBytes(auth),
  );

  const authorization = await createVapidAuthorizationHeader(
    endpoint,
    input.env.VAPID_SUBJECT!,
    input.env.VAPID_PUBLIC_KEY!,
    input.env.VAPID_PRIVATE_KEY!,
  );

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      TTL: "300",
      Urgency: "normal",
      "Content-Length": String(body.length),
      Authorization: authorization,
    },
    body,
  });

  if (!response.ok) {
    const error = new Error(`Push service responded with HTTP ${response.status}`) as Error & {
      statusCode: number;
    };
    error.statusCode = response.status;
    throw error;
  }
}

/** RFC 8291 requires a 65-byte P-256 point and a >= 16-byte auth secret. */
function validateSubscription(subscription: PushSubscriptionLike): void {
  const p256dh = base64UrlToBytes(subscription.p256dh);
  const auth = base64UrlToBytes(subscription.auth);
  if (p256dh.length !== 65) {
    throw new Error("Invalid subscription p256dh key: must decode to 65 bytes.");
  }
  if (auth.length < 16) {
    throw new Error("Invalid subscription auth secret: must be at least 16 bytes.");
  }
}

/** ES256 VAPID JWT + Authorization header, mirroring web-push-neo's vapid.ts. */
async function createVapidAuthorizationHeader(
  endpoint: string,
  subject: string,
  publicKey: string,
  privateKey: string,
): Promise<string> {
  const audience = new URL(endpoint).origin;
  if (audience.length === 0) {
    throw new Error("Invalid push endpoint URL.");
  }
  const parsedSubject = new URL(subject);
  if (parsedSubject.protocol !== "https:" && parsedSubject.protocol !== "mailto:") {
    throw new Error(`Vapid subject is not an https: or mailto: URL. ${subject}`);
  }
  const decodedPublicKey = base64UrlToBytes(publicKey);
  if (decodedPublicKey.length !== 65) {
    throw new Error("Vapid public key should be 65 bytes long when decoded.");
  }

  const header = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({ alg: "ES256" })));
  const payload = bytesToBase64Url(
    new TextEncoder().encode(
      JSON.stringify({
        aud: audience,
        sub: subject,
        exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
      }),
    ),
  );
  const signingInput = `${header}.${payload}`;

  const key = await importVapidSigningKey(privateKey, publicKey);
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      new TextEncoder().encode(signingInput),
    ),
  );

  return `vapid t=${signingInput}.${bytesToBase64Url(signature)},k=${publicKey}`;
}

/**
 * Wrap a raw 32-byte P-256 scalar as PKCS#8, so the key can be imported without
 * JWK support.
 *
 * `web-push generate-vapid-keys` — what most operators run — emits a raw
 * base64url scalar, and web-push-neo imports that as a JWK. celld's WebCrypto
 * rejects JWK import outright (`unsupported key import`), so on the shim path
 * the common key format would fail at signing time while a PKCS#8 key worked.
 * The DER here is the fixed SEC1-in-PKCS#8 template for prime256v1: version,
 * the ecPublicKey/prime256v1 AlgorithmIdentifier, then the private key octet
 * string carrying the scalar and the uncompressed public point.
 */
function rawScalarToPkcs8(scalar: Uint8Array, publicKey: Uint8Array): Uint8Array<ArrayBuffer> {
  if (scalar.length !== 32) throw new Error("vapid_private_key_not_32_bytes");
  if (publicKey.length !== 65) throw new Error("vapid_public_key_not_65_bytes");
  const prefix = new Uint8Array([
    0x30, 0x81, 0x87, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02,
    0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x04, 0x6d, 0x30, 0x6b, 0x02,
    0x01, 0x01, 0x04, 0x20,
  ]);
  const middle = new Uint8Array([0xa1, 0x44, 0x03, 0x42, 0x00]);
  const der = new Uint8Array(prefix.length + 32 + middle.length + 65) as Uint8Array<ArrayBuffer>;
  der.set(prefix, 0);
  der.set(scalar, prefix.length);
  der.set(middle, prefix.length + 32);
  der.set(publicKey, prefix.length + 32 + middle.length);
  return der;
}

/** A raw 32-byte scalar (converted to PKCS#8 above) or an already-PKCS#8 key. */
export async function importVapidSigningKey(
  privateKey: string,
  publicKey: string,
): Promise<CryptoKey> {
  const decodedPrivateKey = base64UrlToBytes(privateKey);
  // Anything that is neither a 32-byte scalar nor DER (0x30 = SEQUENCE) is a
  // misconfigured key. Say that, rather than letting it reach WebCrypto and
  // come back as "Invalid PKCS8 input", which sends the operator looking at the
  // wrong thing.
  if (decodedPrivateKey.length !== 32 && decodedPrivateKey[0] !== 0x30) {
    throw new Error("vapid_private_key_unrecognised_format");
  }
  const pkcs8 =
    decodedPrivateKey.length === 32
      ? rawScalarToPkcs8(decodedPrivateKey, base64UrlToBytes(publicKey))
      : decodedPrivateKey;
  return crypto.subtle.importKey("pkcs8", pkcs8, { name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
  ]);
}

// base64url lives in src/encoding.ts; re-exported so the push tests that
// exercise VAPID key parsing keep importing it from the module under test.
export { bytesToBase64Url };
