/**
 * RSASSA-PKCS1-v1_5 (RS256) signing for runtimes whose native WebCrypto has no
 * RSA (celld). Pure BigInt math plus native `crypto.subtle.digest` for the
 * SHA-256 — no dependencies. The signature is byte-for-byte what
 * `crypto.subtle.sign("RSASSA-PKCS1-v1_5", …)` produces for the same key and
 * message, which the integration suite proves against the workers-pool oracle.
 *
 * Only PKCS#8 keys are accepted (what GitHub's "generate a private key" flow
 * hands out after conversion). RSA *verification*, key generation and PKCS#1
 * parsing are deliberately out of scope — see jwt.ts for the PKCS#1→PKCS#8
 * conversion hint.
 */

/**
 * An RSAPrivateKey (RFC 8017 A.1.2) as parsed from PKCS#8. CRT parameters are
 * kept: signing with them is ~4x faster than plain `m^d mod n`.
 */
export interface RsaPrivateKey {
  /** Modulus n, in bytes (e.g. 256 for a 2048-bit key). Signature length. */
  modulusLength: number;
  n: bigint;
  d: bigint;
  p: bigint;
  q: bigint;
  /** d mod (p-1) */
  dp: bigint;
  /** d mod (q-1) */
  dq: bigint;
  /** q^-1 mod p */
  qInv: bigint;
}

/** DER tag bytes used by the PKCS#8 / RSAPrivateKey structure. */
const TAG_INTEGER = 0x02;
const TAG_OCTET_STRING = 0x04;
const TAG_OID = 0x06;
const TAG_SEQUENCE = 0x30;

/** OID 1.2.840.113549.1.1.1 (rsaEncryption), the PKCS#8 algorithm identifier. */
const RSA_ENCRYPTION_OID = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];

/**
 * EMSA-PKCS1-v1_5 DigestInfo for SHA-256 (RFC 8017 §9.2, RFC 8017 A.2.4):
 * SEQUENCE { SEQUENCE { OID 2.16.840.1.101.3.4.2.1, NULL }, OCTET STRING }.
 * The 32-byte hash follows this 19-byte prefix inside the padded message.
 */
const SHA256_DIGEST_INFO = new Uint8Array([
  0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05,
  0x00, 0x04, 0x20,
]);

interface Tlv {
  tag: number;
  length: number;
  /** Byte offset of the content (after tag + length encoding). */
  content: number;
  /** Total bytes of tag + length encoding. */
  header: number;
}

/** Minimal DER TLV reader. `length` handles long-form encoding (up to 4 bytes). */
function readTlv(bytes: Uint8Array, offset: number): Tlv {
  const tag = bytes[offset];
  if (tag === undefined) {
    throw new Error("github_private_key_truncated");
  }
  const firstLengthByte = bytes[offset + 1];
  if (firstLengthByte === undefined) {
    throw new Error("github_private_key_truncated");
  }
  if (firstLengthByte === 0x80) {
    // DER forbids indefinite-length encoding; reject rather than misparse.
    throw new Error("github_private_key_bad_length");
  }
  let length = firstLengthByte;
  let extra = 0;
  if (length & 0x80) {
    extra = length & 0x7f;
    if (extra > 4) {
      throw new Error("github_private_key_bad_length");
    }
    length = 0;
    for (let i = 0; i < extra; i++) {
      const byte = bytes[offset + 2 + i];
      if (byte === undefined) {
        throw new Error("github_private_key_truncated");
      }
      length = length * 256 + byte;
    }
  }
  const header = 2 + extra;
  if (offset + header + length > bytes.length) {
    throw new Error("github_private_key_truncated");
  }
  return { tag, length, header, content: offset + header };
}

/** DER INTEGER content → bigint (positive; strips the sign byte if present). */
function integerToBigInt(bytes: Uint8Array): bigint {
  let body = bytes;
  if (body.length > 1 && body[0] === 0) {
    body = body.slice(1);
  }
  let value = 0n;
  for (const byte of body) {
    value = value * 256n + BigInt(byte);
  }
  return value;
}

function expectTag(tlv: Tlv, tag: number, what: string): void {
  if (tlv.tag !== tag) {
    throw new Error(`github_private_key_not_${what}`);
  }
}

/**
 * Parse a PKCS#8 RSA private key (RFC 5208 wrapping an RFC 8017 A.1.2
 * RSAPrivateKey) and validate the CRT parameters against the modulus, so a
 * corrupt key throws instead of producing a wrong-looking signature.
 */
export function parsePkcs8RsaPrivateKey(der: Uint8Array): RsaPrivateKey {
  const pkcs8 = readTlv(der, 0);
  expectTag(pkcs8, TAG_SEQUENCE, "pkcs8");
  if (pkcs8.length !== der.length - pkcs8.header) {
    throw new Error("github_private_key_trailing_bytes");
  }

  let offset = pkcs8.content;
  const version = readTlv(der, offset);
  expectTag(version, TAG_INTEGER, "pkcs8");
  if (version.length !== 1 || der[version.content] !== 0) {
    throw new Error("github_private_key_bad_version");
  }
  offset += version.header + version.length;

  const algorithm = readTlv(der, offset);
  expectTag(algorithm, TAG_SEQUENCE, "algorithm");
  const oid = readTlv(der, algorithm.content);
  expectTag(oid, TAG_OID, "algorithm");
  if (
    oid.length !== RSA_ENCRYPTION_OID.length ||
    RSA_ENCRYPTION_OID.some((byte, i) => der[oid.content + i] !== byte)
  ) {
    throw new Error("github_private_key_not_rsa");
  }
  offset += algorithm.header + algorithm.length;

  const privateKey = readTlv(der, offset);
  expectTag(privateKey, TAG_OCTET_STRING, "pkcs8");
  const rsa = readTlv(der, privateKey.content);
  expectTag(rsa, TAG_SEQUENCE, "rsa");

  let cursor = rsa.content;
  const integers: bigint[] = [];
  for (let i = 0; i < 9; i++) {
    const tlv = readTlv(der, cursor);
    expectTag(tlv, TAG_INTEGER, "rsa");
    integers.push(integerToBigInt(der.slice(tlv.content, tlv.content + tlv.length)));
    cursor += tlv.header + tlv.length;
  }
  const keyVersion = integers[0];
  const n = integers[1];
  const d = integers[3];
  const p = integers[4];
  const q = integers[5];
  const dp = integers[6];
  const dq = integers[7];
  const qInv = integers[8];
  if (
    keyVersion === undefined ||
    n === undefined ||
    d === undefined ||
    p === undefined ||
    q === undefined ||
    dp === undefined ||
    dq === undefined ||
    qInv === undefined
  ) {
    throw new Error("github_private_key_invalid");
  }
  if (keyVersion !== 0n) {
    throw new Error("github_private_key_bad_version");
  }
  if (n <= 0n || d <= 0n || p <= 1n || q <= 1n) {
    throw new Error("github_private_key_invalid");
  }
  // The CRT parameters must actually belong to this modulus; otherwise a
  // corrupt key emits a plausible-looking but wrong signature.
  if (p * q !== n) {
    throw new Error("github_private_key_invalid");
  }
  if (dp !== d % (p - 1n) || dq !== d % (q - 1n)) {
    throw new Error("github_private_key_invalid");
  }
  if ((qInv * q) % p !== 1n) {
    throw new Error("github_private_key_invalid");
  }

  const modulusLength = Math.ceil(n.toString(16).length / 2);
  return { modulusLength, n, d, p, q, dp, dq, qInv };
}

/** Square-and-multiply modular exponentiation, keeping intermediates small. */
function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let factor = base % modulus;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) {
      result = (result * factor) % modulus;
    }
    factor = (factor * factor) % modulus;
    e >>= 1n;
  }
  return result;
}

/**
 * Sign `data` with an RS256 (RSASSA-PKCS1-v1_5 + SHA-256) PKCS#8 key, using
 * CRT. The returned signature is exactly `modulusLength` bytes — a leading
 * zero is preserved, never trimmed (that trim is the once-in-256 bug).
 */
export async function signRs256Pkcs8(
  der: Uint8Array,
  data: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = parsePkcs8RsaPrivateKey(der);

  // Copy onto a fresh ArrayBuffer: WebCrypto's BufferSource wants a
  // Uint8Array<ArrayBuffer>, and callers may hand us a slice.
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(data)));
  const t = new Uint8Array(SHA256_DIGEST_INFO.length + hash.length);
  t.set(SHA256_DIGEST_INFO, 0);
  t.set(hash, SHA256_DIGEST_INFO.length);

  // EMSA-PKCS1-v1_5: 0x00 0x01 0xFF…0xFF 0x00 || T, with >= 8 FF bytes.
  const psLength = key.modulusLength - t.length - 3;
  if (psLength < 8) {
    throw new Error("github_private_key_too_small");
  }
  const em = new Uint8Array(key.modulusLength);
  em[0] = 0x00;
  em[1] = 0x01;
  em.fill(0xff, 2, 2 + psLength);
  em[2 + psLength] = 0x00;
  em.set(t, 3 + psLength);

  const message = integerToBigInt(em);
  // Garner's CRT combination: s = m2 + q * ((qInv * (m1 - m2)) mod p).
  const m1 = modPow(message % key.p, key.dp, key.p);
  const m2 = modPow(message % key.q, key.dq, key.q);
  let h = (m1 - m2) % key.p;
  if (h < 0n) {
    h += key.p;
  }
  const signature = m2 + key.q * ((key.qInv * h) % key.p);

  // Left-pad to exactly the modulus length; a leading-zero signature must
  // keep its zero.
  const hex = signature.toString(16).padStart(key.modulusLength * 2, "0");
  const padded = new Uint8Array(key.modulusLength);
  for (let i = 0; i < key.modulusLength; i++) {
    padded[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return padded;
}
