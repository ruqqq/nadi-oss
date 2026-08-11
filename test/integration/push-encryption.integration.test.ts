import { describe, expect, it, vi } from "vitest";
import { generateRequestDetails } from "web-push-neo";

import { p256 } from "@noble/curves/p256";

import {
  deriveContentKeys,
  deriveIkm,
  ecdhSharedSecret,
  encryptPayloadAes128Gcm,
} from "../../src/notifications/push-encryption";
import {
  bytesToBase64Url as bytesToBase64UrlForTest,
  importVapidSigningKey as importVapidSigningKeyForTest,
  nativeEcdhAvailable,
} from "../../src/notifications/web-push";

/**
 * RFC 8291 correctness gate for the celld payload-encryption shim. This suite
 * runs in the workers pool, where native WebCrypto has ECDH/HKDF/AES-GCM —
 * that is the oracle: everything the shim computes with @noble/* is compared
 * byte-for-byte against `crypto.subtle`, and the whole aes128gcm body is
 * compared byte-for-byte against web-push-neo (the Cloudflare reference).
 *
 * Every test also proves it can fail: a tampered input no longer matches.
 */

const textEncoder = new TextEncoder();

// Fixed, deterministic key material so web-push-neo and the shim get the same inputs.
const EPHERMERAL_PRIVATE = new Uint8Array(32).fill(0x22);
const SUBSCRIBER_PRIVATE = new Uint8Array(32).fill(0x11);
const WRONG_SUBSCRIBER_PRIVATE = new Uint8Array(32).fill(0x33);
const AUTH_SECRET = new Uint8Array(16).fill(0xaa);
const FIXED_SALT = new Uint8Array(16).fill(0x07);

const SUBSCRIBER_PUBLIC = new Uint8Array(p256.getPublicKey(SUBSCRIBER_PRIVATE, false)); // 65 bytes
const EPHEMERAL_PUBLIC = new Uint8Array(p256.getPublicKey(EPHERMERAL_PRIVATE, false)); // 65 bytes

const PAYLOAD = "Nadi slice 8: RFC 8291 byte-identity against web-push-neo";
const ENDPOINT = "https://push.example.com/sub";

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
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

/** JWK for a fixed P-256 private scalar (x/y derived from the curve). */
function privateScalarJwk(privateScalar: Uint8Array): JsonWebKey {
  const publicKey = p256.getPublicKey(privateScalar, false);
  return {
    kty: "EC",
    crv: "P-256",
    x: bytesToBase64Url(publicKey.slice(1, 33)),
    y: bytesToBase64Url(publicKey.slice(33, 65)),
    d: bytesToBase64Url(privateScalar),
  };
}

async function importEcdhPrivate(privateScalar: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    privateScalarJwk(privateScalar),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
}

async function nativeEcdhSharedSecret(
  ephemeralPrivate: Uint8Array,
  subscriberPublic: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const subscriberKey = await crypto.subtle.importKey(
    "raw",
    subscriberPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: subscriberKey },
      await importEcdhPrivate(ephemeralPrivate),
      256,
    ),
  );
}

/** RFC 8291 decryption using only native WebCrypto — the oracle. */
async function decryptAes128Gcm(
  body: Uint8Array<ArrayBuffer>,
  subscriberPrivate: Uint8Array,
  authSecret: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const salt = body.slice(0, 16);
  const recordSize = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0);
  if (recordSize !== 4096) {
    throw new Error(`Unexpected record size ${recordSize}`);
  }
  const keyIdLength = body[20]!;
  const ephemeralPublic = body.slice(21, 21 + keyIdLength);
  const ciphertext = body.slice(21 + keyIdLength);
  const subscriberPublic = p256.getPublicKey(subscriberPrivate, false);

  const sharedSecret = await nativeEcdhSharedSecret(subscriberPrivate, ephemeralPublic);
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
  if (padded[padded.length - 1] !== 0x02) {
    throw new Error("Missing aes128gcm padding delimiter");
  }
  return padded.slice(0, -1);
}

describe("push payload encryption on the celld path (workers-pool oracle)", () => {
  it("1. ECDH shared secret is byte-identical to native deriveBits", async () => {
    const native = await nativeEcdhSharedSecret(EPHERMERAL_PRIVATE, SUBSCRIBER_PUBLIC);
    const ours = ecdhSharedSecret(EPHERMERAL_PRIVATE, SUBSCRIBER_PUBLIC);
    expect(ours).toEqual(native);
    expect(ours.length).toBe(32);

    // Break: a different ephemeral key must not produce the same secret.
    const tampered = EPHERMERAL_PRIVATE.slice();
    tampered[31] = tampered[31]! ^ 0x01;
    expect(ecdhSharedSecret(tampered, SUBSCRIBER_PUBLIC)).not.toEqual(native);
  });

  it("2. HKDF content key and nonce are byte-identical to native", async () => {
    const sharedSecret = ecdhSharedSecret(EPHERMERAL_PRIVATE, SUBSCRIBER_PUBLIC);
    const ikm = deriveIkm(sharedSecret, AUTH_SECRET, SUBSCRIBER_PUBLIC, EPHEMERAL_PUBLIC);
    const { contentEncryptionKey, nonce } = deriveContentKeys(ikm, FIXED_SALT);

    const sharedKey = await crypto.subtle.importKey("raw", sharedSecret, "HKDF", false, [
      "deriveBits",
    ]);
    const nativeIkm = new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: AUTH_SECRET,
          info: concatBytes(
            textEncoder.encode("WebPush: info\0"),
            SUBSCRIBER_PUBLIC,
            EPHEMERAL_PUBLIC,
          ),
        },
        sharedKey,
        32 * 8,
      ),
    );
    const ikmKey = await crypto.subtle.importKey("raw", nativeIkm, "HKDF", false, ["deriveBits"]);
    const nativeCek = new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: FIXED_SALT,
          info: textEncoder.encode("Content-Encoding: aes128gcm\0"),
        },
        ikmKey,
        16 * 8,
      ),
    );
    const nativeNonce = new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: FIXED_SALT,
          info: textEncoder.encode("Content-Encoding: nonce\0"),
        },
        ikmKey,
        12 * 8,
      ),
    );

    expect(ikm).toEqual(nativeIkm);
    expect(contentEncryptionKey).toEqual(nativeCek);
    expect(nonce).toEqual(nativeNonce);

    // Break: a different salt must not produce the same key material.
    const otherSalt = new Uint8Array(16).fill(0x99);
    expect(deriveContentKeys(ikm, otherSalt).contentEncryptionKey).not.toEqual(nativeCek);
  });

  it("3. whole aes128gcm payload is byte-identical to web-push-neo", async () => {
    // Drive web-push-neo with the exact fixed salt and ephemeral keypair the
    // shim will be given, by stubbing its two randomness entry points.
    const fixedEphKeyPair: CryptoKeyPair = {
      publicKey: await crypto.subtle.importKey(
        "raw",
        EPHEMERAL_PUBLIC,
        { name: "ECDH", namedCurve: "P-256" },
        true,
        [],
      ),
      privateKey: await crypto.subtle.importKey(
        "jwk",
        privateScalarJwk(EPHERMERAL_PRIVATE),
        { name: "ECDH", namedCurve: "P-256" },
        true,
        ["deriveBits"],
      ),
    };
    const generateKeySpy = vi
      .spyOn(crypto.subtle, "generateKey")
      .mockImplementation(async () => fixedEphKeyPair);
    const getRandomValuesSpy = vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
      (array as Uint8Array<ArrayBuffer>).set(FIXED_SALT);
      return array;
    });

    const reference = await generateRequestDetails(
      {
        endpoint: ENDPOINT,
        keys: { p256dh: bytesToBase64Url(SUBSCRIBER_PUBLIC), auth: bytesToBase64Url(AUTH_SECRET) },
      },
      PAYLOAD,
      { TTL: 300 },
    );

    generateKeySpy.mockRestore();
    getRandomValuesSpy.mockRestore();

    const ours = await encryptPayloadAes128Gcm(
      textEncoder.encode(PAYLOAD),
      SUBSCRIBER_PUBLIC,
      AUTH_SECRET,
      {
        salt: FIXED_SALT,
        ephemeralPrivateKey: EPHERMERAL_PRIVATE,
      },
    );
    expect(ours).toEqual(new Uint8Array(reference.body!));

    // Break: injecting a different salt must diverge from the reference.
    const otherSalt = new Uint8Array(16).fill(0x99);
    const different = await encryptPayloadAes128Gcm(
      textEncoder.encode(PAYLOAD),
      SUBSCRIBER_PUBLIC,
      AUTH_SECRET,
      {
        salt: otherSalt,
        ephemeralPrivateKey: EPHERMERAL_PRIVATE,
      },
    );
    expect(different).not.toEqual(new Uint8Array(reference.body!));
  });

  it("4. our payload decrypts with native WebCrypto back to the exact plaintext", async () => {
    const body = await encryptPayloadAes128Gcm(
      textEncoder.encode(PAYLOAD),
      SUBSCRIBER_PUBLIC,
      AUTH_SECRET,
    );
    await expect(decryptAes128Gcm(body, SUBSCRIBER_PRIVATE, AUTH_SECRET)).resolves.toEqual(
      textEncoder.encode(PAYLOAD),
    );

    // Break: a corrupted ciphertext must not decrypt.
    const corrupted = body.slice();
    corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 0x01;
    await expect(decryptAes128Gcm(corrupted, SUBSCRIBER_PRIVATE, AUTH_SECRET)).rejects.toThrow();
  });

  it("5. a wrong subscription key does not recover the plaintext", async () => {
    const body = await encryptPayloadAes128Gcm(
      textEncoder.encode(PAYLOAD),
      SUBSCRIBER_PUBLIC,
      AUTH_SECRET,
    );
    await expect(decryptAes128Gcm(body, WRONG_SUBSCRIBER_PRIVATE, AUTH_SECRET)).rejects.toThrow();
  });

  it("sanity: the pool's native WebCrypto has ECDH (the oracle exists here)", async () => {
    await expect(nativeEcdhAvailable()).resolves.toBe(true);
  });
});

describe("VAPID key import without JWK", () => {
  // web-push generate-vapid-keys emits a raw 32-byte scalar, and web-push-neo
  // imports it as a JWK — which celld's WebCrypto rejects outright. The shim
  // wraps the scalar as PKCS#8 instead; this proves the wrapping is equivalent
  // to the JWK import it replaces, by checking both keys sign verifiably for
  // the same public key. (ECDSA is randomised, so signatures cannot be compared
  // byte-for-byte — verification is the right equality here.)
  it("a wrapped raw scalar signs the same as the JWK import it replaces", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;

    const rawPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    const scalar = Uint8Array.from(atob(jwk.d!.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
      c.charCodeAt(0),
    );
    expect(scalar.length).toBe(32);

    const message = new TextEncoder().encode("vapid signing input");

    // The path the shim takes: raw scalar -> PKCS#8 -> importKey("pkcs8")
    const viaPkcs8 = await importVapidSigningKeyForTest(
      bytesToBase64UrlForTest(scalar),
      bytesToBase64UrlForTest(rawPublic),
    );
    const signature = new Uint8Array(
      await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, viaPkcs8, message),
    );

    // Verified against the ORIGINAL public key: the wrapping preserved the key.
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        pair.publicKey,
        signature,
        message,
      ),
    ).toBe(true);
  });

  it("names a misconfigured key rather than surfacing a PKCS8 parse error", async () => {
    // 31 bytes is neither a P-256 scalar nor DER. Before this check it reached
    // WebCrypto and came back as "Invalid PKCS8 input", which points the
    // operator at the wrong thing.
    await expect(
      importVapidSigningKeyForTest(
        bytesToBase64UrlForTest(new Uint8Array(31)),
        bytesToBase64UrlForTest(new Uint8Array(65)),
      ),
    ).rejects.toThrow(/vapid_private_key_unrecognised_format/);
  });
});
