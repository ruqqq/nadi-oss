import type { GithubAppConfig } from "./config";
import { bytesToBase64Url } from "../encoding";
import { signRs256Pkcs8 } from "./rs256";

function b64urlJson(value: unknown): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

/**
 * Capability probe: does this runtime's native WebCrypto support RSA? Choosing
 * by capability rather than platform means a future celld that gains RSA
 * silently stops using the shim.
 *
 * **The probe signs, it does not merely import.** It used to stop at the
 * PKCS#8 import, on the reasoning that a runtime without RSA rejects the key
 * outright — which celld 0.1.0 did (`unsupported key import`). celld 0.2.0
 * broke that assumption: it accepts the import and then throws on sign
 * (`unsupported sign algorithm: RSASSA-PKCS1-V1_5`), so an import-only probe
 * reports native support, takes the native path, and fails every GitHub App
 * JWT — i.e. all private-repo clone/push. Probe the operation that has to
 * work, not a proxy for it.
 *
 * The probe uses the caller's own key rather than an embedded one: it is the
 * exact operation the native path would perform, and it keeps a private key
 * blob out of this source file. A key that fails for some *other* reason
 * (corrupt DER) falls through to the shim, which reports a precise parse error
 * instead of WebCrypto's opaque `DataError`.
 *
 * The result is memoized per isolate; a deployment has one GitHub App key.
 */
let nativeRsaCached: boolean | undefined;

export async function nativeRsaAvailable(pkcs8Der: Uint8Array): Promise<boolean> {
  if (nativeRsaCached !== undefined) {
    return nativeRsaCached;
  }
  try {
    const key = await crypto.subtle.importKey(
      "pkcs8",
      pkcs8Der.buffer as ArrayBuffer,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new Uint8Array([0]));
    nativeRsaCached = true;
  } catch {
    nativeRsaCached = false;
  }
  return nativeRsaCached;
}

export async function importPkcs8(pem: string): Promise<CryptoKey> {
  const der = pemToDer(pem);
  return crypto.subtle.importKey(
    "pkcs8",
    der.buffer as ArrayBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/** Strip PEM armor from a PKCS#8 key, rejecting PKCS#1 with a conversion hint. */
function pemToDer(pem: string): Uint8Array {
  if (pem.includes("BEGIN RSA PRIVATE KEY")) {
    throw new Error(
      "github_private_key_not_pkcs8: found a PKCS#1 key (BEGIN RSA PRIVATE KEY); " +
        "convert it to PKCS#8 with: openssl pkcs8 -topk8 -nocrypt -in github-app.pem " +
        "-out github-app-pkcs8.pem",
    );
  }
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
}

export async function createAppJwt(config: GithubAppConfig, nowMs: number): Promise<string> {
  // pemToDer first, so a PKCS#1 key reports the conversion hint rather than
  // being mistaken for "this runtime has no RSA".
  const der = pemToDer(config.privateKeyPkcs8Pem);
  return createAppJwtWithRsa(config, nowMs, await nativeRsaAvailable(der));
}

/**
 * Test seam: run the exact platform path for a forced capability result, so
 * the celld fallback can be exercised where native RSA actually exists.
 * Production callers use {@link createAppJwt}, which probes.
 */
export async function createAppJwtWithRsa(
  config: GithubAppConfig,
  nowMs: number,
  nativeRsa: boolean,
): Promise<string> {
  const nowSec = Math.floor(nowMs / 1000);
  const header = b64urlJson({ alg: "RS256", typ: "JWT" });
  const payload = b64urlJson({ iss: config.appId, iat: nowSec - 60, exp: nowSec + 540 });
  const signingInput = `${header}.${payload}`;
  const bytes = new TextEncoder().encode(signingInput);

  if (nativeRsa) {
    const key = await importPkcs8(config.privateKeyPkcs8Pem);
    const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, bytes));
    return `${signingInput}.${bytesToBase64Url(sig)}`;
  }
  const sig = await signRs256Pkcs8(pemToDer(config.privateKeyPkcs8Pem), bytes);
  return `${signingInput}.${bytesToBase64Url(sig)}`;
}
