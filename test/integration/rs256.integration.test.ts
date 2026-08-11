import { beforeAll, describe, expect, it, vi } from "vitest";

import type { GithubAppConfig } from "../../src/github/config";
import {
  createAppJwt,
  createAppJwtWithRsa,
  importPkcs8,
  nativeRsaAvailable,
} from "../../src/github/jwt";
import { parsePkcs8RsaPrivateKey, signRs256Pkcs8 } from "../../src/github/rs256";

/**
 * RS256 (RSASSA-PKCS1-v1_5) correctness gate for the celld signing shim. This
 * suite runs in the workers pool, where native WebCrypto has RSA — that is
 * the oracle. The shim's BigInt signature is compared byte-for-byte against
 * `crypto.subtle.sign`, verified with `crypto.subtle.verify`, and probed for
 * the exact-length padding failure (a leading-zero signature must keep its
 * zero — trimming it fails ~1 in 256 signatures, months later).
 *
 * RS256 is deterministic, so byte-identity is the whole gate.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function b64std(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const binary = atob(
    s.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((s.length + 3) % 4),
  );
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

async function generateRsaKeyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
}

const APP_ID = "555";
const NOW_MS = 1_700_000_000_000;

function configWith(pem: string): GithubAppConfig {
  return {
    appId: APP_ID,
    privateKeyPkcs8Pem: pem,
    clientId: "Iv1.test",
    clientSecret: "s",
    slug: "nadi",
  };
}

let privateKey: CryptoKey;
let publicKey: CryptoKey;
let pkcs8Der: Uint8Array<ArrayBuffer>;
let pkcs8Pem: string;

beforeAll(async () => {
  const pair = await generateRsaKeyPair();
  privateKey = pair.privateKey;
  publicKey = pair.publicKey;
  pkcs8Der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", privateKey));
  pkcs8Pem = `-----BEGIN PRIVATE KEY-----\n${b64std(pkcs8Der)}\n-----END PRIVATE KEY-----`;
});

describe("RS256 on the celld path (workers-pool oracle)", () => {
  it("sanity: the pool's native WebCrypto has RSA (the oracle exists here)", async () => {
    expect(pkcs8Der.length).toBeGreaterThan(1100); // a 2048-bit PKCS#8 key
    expect(parsePkcs8RsaPrivateKey(pkcs8Der).modulusLength).toBe(256);
    expect(await nativeRsaAvailable(pkcs8Der)).toBe(true);
  });

  it("1. shim signatures are byte-identical to native crypto.subtle.sign (2048-bit)", async () => {
    const messages = [
      "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiI1NTUiLCJpYXQiOjE3MDAwMDAwMDAsImV4cCI6MTcwMDAwMDU0MH0",
      "a",
      "github-app-jwt signing input ".repeat(10),
    ];
    for (const message of messages) {
      const bytes = textEncoder.encode(message);
      const ours = await signRs256Pkcs8(pkcs8Der, bytes);
      const native = new Uint8Array(
        await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, bytes),
      );
      expect(ours).toEqual(native);
      expect(ours.length).toBe(256);

      // Break: signing a different message must not produce the same signature.
      const other = new Uint8Array(
        await crypto.subtle.sign(
          "RSASSA-PKCS1-v1_5",
          privateKey,
          textEncoder.encode(`${message}${message}`),
        ),
      );
      expect(ours).not.toEqual(other);
    }
  });

  it("2. a shim-minted JWT verifies with native WebCrypto", async () => {
    const jwt = await createAppJwtWithRsa(configWith(pkcs8Pem), NOW_MS, false);
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);
    const header = JSON.parse(textDecoder.decode(b64urlDecode(parts[0]!)));
    const payload = JSON.parse(textDecoder.decode(b64urlDecode(parts[1]!)));
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(payload.iss).toBe(APP_ID);
    expect(payload.iat).toBe(Math.floor(NOW_MS / 1000) - 60);
    expect(payload.exp).toBe(Math.floor(NOW_MS / 1000) + 540);

    const signature = b64urlDecode(parts[2]!);
    expect(signature.length).toBe(256);
    const signingInput = textEncoder.encode(`${parts[0]}.${parts[1]}`);
    expect(
      await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, signature, signingInput),
    ).toBe(true);

    // Break: the signature must not verify against a different public key.
    const otherPair = await generateRsaKeyPair();
    expect(
      await crypto.subtle.verify("RSASSA-PKCS1-v1_5", otherPair.publicKey, signature, signingInput),
    ).toBe(false);
  });

  it("3. a tampered payload or signature fails verification", async () => {
    const jwt = await createAppJwtWithRsa(configWith(pkcs8Pem), NOW_MS, false);
    const [header, payload, sigB64] = jwt.split(".") as [string, string, string];

    const tamperedPayload =
      payload.slice(0, 4) + (payload[4] === "A" ? "B" : "A") + payload.slice(5);
    expect(tamperedPayload).not.toBe(payload);
    const input = textEncoder.encode(`${header}.${tamperedPayload}`);
    expect(
      await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, b64urlDecode(sigB64), input),
    ).toBe(false);

    const tamperedSignature = b64urlDecode(sigB64);
    tamperedSignature[100] = tamperedSignature[100]! ^ 0x01;
    expect(
      await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        publicKey,
        tamperedSignature,
        textEncoder.encode(`${header}.${payload}`),
      ),
    ).toBe(false);
  });

  it("4. every signature is exactly the modulus length, including leading-zero ones", async () => {
    // A leading-zero signature happens with probability ~1/256 per message, so
    // this loop is virtually certain to hit one well before the cap; the gate
    // is that each signature is still exactly 256 bytes and still verifies.
    let leadingZeroFound = false;
    for (let i = 0; i < 4096; i++) {
      const message = textEncoder.encode(`leading-zero-search-${i}`);
      const signature = await signRs256Pkcs8(pkcs8Der, message);
      expect(signature.length).toBe(256);
      if (signature[0] === 0) {
        leadingZeroFound = true;
        // The zero is padding, not corruption: the signature still verifies.
        expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, signature, message)).toBe(
          true,
        );
        break;
      }
    }
    expect(leadingZeroFound).toBe(true);
  }, 120_000);

  it("5. a PKCS#1 key names the conversion; malformed keys throw instead of signing", async () => {
    const pkcs1Pem = `-----BEGIN RSA PRIVATE KEY-----\n${b64std(pkcs8Der)}\n-----END RSA PRIVATE KEY-----`;
    await expect(importPkcs8(pkcs1Pem)).rejects.toThrow(/github_private_key_not_pkcs8/);
    await expect(importPkcs8(pkcs1Pem)).rejects.toThrow(/openssl pkcs8 -topk8 -nocrypt/);
    await expect(createAppJwtWithRsa(configWith(pkcs1Pem), NOW_MS, false)).rejects.toThrow(
      /github_private_key_not_pkcs8/,
    );
    // The production entry probes with the caller's key, so a PKCS#1 key must
    // still surface the conversion hint rather than being read as "no RSA".
    await expect(createAppJwt(configWith(pkcs1Pem), NOW_MS)).rejects.toThrow(
      /openssl pkcs8 -topk8 -nocrypt/,
    );

    const message = textEncoder.encode("x");
    // Empty and truncated DERs throw instead of emitting a signature.
    await expect(signRs256Pkcs8(new Uint8Array(), message)).rejects.toThrow();
    await expect(signRs256Pkcs8(pkcs8Der.slice(0, 100), message)).rejects.toThrow();
    // Trailing garbage after the outer SEQUENCE throws.
    const withTrailing = new Uint8Array(pkcs8Der.length + 4);
    withTrailing.set(pkcs8Der);
    withTrailing.fill(0xab, pkcs8Der.length);
    await expect(signRs256Pkcs8(withTrailing, message)).rejects.toThrow();

    // A non-RSA (EC) PKCS#8 key throws a clear "not RSA" error.
    const ecPair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
    ])) as CryptoKeyPair;
    const ecDer = new Uint8Array(await crypto.subtle.exportKey("pkcs8", ecPair.privateKey));
    await expect(signRs256Pkcs8(ecDer, message)).rejects.toThrow(/github_private_key_not_rsa/);

    // A key whose CRT parameters no longer match its modulus throws rather
    // than emitting a plausible-looking wrong signature: flip one byte inside
    // the modulus, leaving p/q untouched (p*q !== n).
    const corruptModulus = pkcs8Der.slice();
    corruptModulus[100] = corruptModulus[100]! ^ 0xff;
    await expect(signRs256Pkcs8(corruptModulus, message)).rejects.toThrow(
      /github_private_key_invalid/,
    );
  });

  it("6. the capability probe is memoized and the native path is chosen when RSA exists", async () => {
    // Fresh module instance so the probe cache is provably cold: in the
    // shared pool isolate an earlier test (or file) may have warmed it.
    vi.resetModules();
    const freshJwt = await import("../../src/github/jwt");

    const importSpy = vi.spyOn(crypto.subtle, "importKey");
    try {
      expect(await freshJwt.nativeRsaAvailable(pkcs8Der)).toBe(true);
      const callsAfterFirstProbe = importSpy.mock.calls.length;
      expect(callsAfterFirstProbe).toBeGreaterThan(0); // the probe really imported
      expect(await freshJwt.nativeRsaAvailable(pkcs8Der)).toBe(true);
      // The second probe resolves from the memo; it must not import again.
      expect(importSpy.mock.calls.length).toBe(callsAfterFirstProbe);
    } finally {
      importSpy.mockRestore();
    }

    // The production entry must take the native path here (RSA exists), which
    // is observable: crypto.subtle.sign is only ever called on that path.
    const signSpy = vi.spyOn(crypto.subtle, "sign");
    try {
      const jwt = await freshJwt.createAppJwt(configWith(pkcs8Pem), NOW_MS);
      expect(signSpy.mock.calls.some(([algorithm]) => algorithm === "RSASSA-PKCS1-v1_5")).toBe(
        true,
      );
      const parts = jwt.split(".");
      expect(parts).toHaveLength(3);
      expect(
        await crypto.subtle.verify(
          "RSASSA-PKCS1-v1_5",
          publicKey,
          b64urlDecode(parts[2]!),
          textEncoder.encode(`${parts[0]}.${parts[1]}`),
        ),
      ).toBe(true);
    } finally {
      signSpy.mockRestore();
    }
  });
});
