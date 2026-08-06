import { p256 } from "@noble/curves/p256";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

/**
 * RFC 8291 (`aes128gcm`) web push payload encryption for runtimes whose native
 * WebCrypto has no ECDH (celld). ECDH + HKDF come from @noble/*; AES-GCM stays
 * native, because it works there. The byte layout matches web-push-neo's
 * `encryptPayload` exactly, so a payload produced here is interchangeable with
 * web-push-neo's and decrypts on any RFC 8291 client.
 *
 * Reference (web-push-neo src/encryption.ts):
 *   1. salt = 16 random bytes
 *   2. ephemeral P-256 keypair; shared = ECDH(eph, subscriber) (x-coordinate)
 *   3. IKM  = HKDF(salt=auth, ikm=shared, info="WebPush: info\0" || sub_pub || eph_pub)
 *   4. CEK  = HKDF(salt=salt, ikm=IKM,  info="Content-Encoding: aes128gcm\0") -> 16 bytes
 *   5. nonce= HKDF(salt=salt, ikm=IKM,  info="Content-Encoding: nonce\0") -> 12 bytes
 *   6. body = salt || u32be(4096) || u8(65) || eph_pub || AES-128-GCM(CEK, nonce, payload || 0x02)
 */

const textEncoder = new TextEncoder();

const IKM_INFO_PREFIX = textEncoder.encode("WebPush: info\0");
const CEK_INFO = textEncoder.encode("Content-Encoding: aes128gcm\0");
const NONCE_INFO = textEncoder.encode("Content-Encoding: nonce\0");

const SALT_LENGTH = 16;
const IKM_LENGTH = 32;
const KEY_LENGTH = 16; // AES-128
const NONCE_LENGTH = 12;
const RECORD_SIZE = 4096;
const PADDING_DELIMITER = 0x02;

/**
 * Test-only injection points. Production callers omit both, and a fresh salt
 * and ephemeral key are generated per message.
 */
export interface EncryptOptions {
  salt?: Uint8Array;
  ephemeralPrivateKey?: Uint8Array;
}

/** ECDH shared secret (x-coordinate, 32 bytes) computed with @noble/curves. */
export function ecdhSharedSecret(
  ephemeralPrivateKey: Uint8Array,
  subscriberPublicKey: Uint8Array,
): Uint8Array<ArrayBuffer> {
  // noble returns the shared point; WebCrypto's deriveBits yields exactly the
  // x-coordinate, so slice it out of the uncompressed encoding. The copy also
  // normalizes noble's ArrayBufferLike-typed output for WebCrypto consumers.
  const point = p256.getSharedSecret(ephemeralPrivateKey, subscriberPublicKey, false);
  return new Uint8Array(point.slice(1, 33));
}

/**
 * RFC 8291 IKM: HKDF-SHA256 with the auth secret as salt, the ECDH shared
 * secret as IKM, and info = "WebPush: info\0" || subscriber_public ||
 * ephemeral_public.
 */
export function deriveIkm(
  sharedSecret: Uint8Array,
  authSecret: Uint8Array,
  subscriberPublicKey: Uint8Array,
  ephemeralPublicKey: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const info = concatBytes(IKM_INFO_PREFIX, subscriberPublicKey, ephemeralPublicKey);
  return new Uint8Array(hkdf(sha256, sharedSecret, authSecret, info, IKM_LENGTH));
}

export interface ContentKeys {
  contentEncryptionKey: Uint8Array<ArrayBuffer>;
  nonce: Uint8Array<ArrayBuffer>;
}

/** RFC 8188 content encryption key and nonce derived from the IKM. */
export function deriveContentKeys(ikm: Uint8Array, salt: Uint8Array): ContentKeys {
  return {
    contentEncryptionKey: new Uint8Array(hkdf(sha256, ikm, salt, CEK_INFO, KEY_LENGTH)),
    nonce: new Uint8Array(hkdf(sha256, ikm, salt, NONCE_INFO, NONCE_LENGTH)),
  };
}

/**
 * Encrypt a web push payload per RFC 8291, producing the complete
 * `aes128gcm` body (header + ciphertext). `subscriberPublicKey` is the 65-byte
 * uncompressed P-256 point and `authSecret` the subscription auth secret.
 */
export async function encryptPayloadAes128Gcm(
  payload: Uint8Array,
  subscriberPublicKey: Uint8Array,
  authSecret: Uint8Array,
  options: EncryptOptions = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const ephemeralPrivateKey = options.ephemeralPrivateKey ?? p256.utils.randomPrivateKey();
  const ephemeralPublicKey = p256.getPublicKey(ephemeralPrivateKey, false);

  const sharedSecret = ecdhSharedSecret(ephemeralPrivateKey, subscriberPublicKey);
  const ikm = deriveIkm(sharedSecret, authSecret, subscriberPublicKey, ephemeralPublicKey);
  const { contentEncryptionKey, nonce } = deriveContentKeys(ikm, salt);

  const paddedPayload = concatBytes(payload, new Uint8Array([PADDING_DELIMITER]));
  const key = await crypto.subtle.importKey(
    "raw",
    contentEncryptionKey,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, paddedPayload),
  );

  const header = new Uint8Array(SALT_LENGTH + 4 + 1 + ephemeralPublicKey.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(SALT_LENGTH, RECORD_SIZE);
  header[SALT_LENGTH + 4] = ephemeralPublicKey.length;
  header.set(ephemeralPublicKey, SALT_LENGTH + 5);

  return concatBytes(header, ciphertext);
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
