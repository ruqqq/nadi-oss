import type { GithubAppConfig } from "./config";

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlJson(value: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(value)));
}

export async function importPkcs8(pem: string): Promise<CryptoKey> {
  if (pem.includes("BEGIN RSA PRIVATE KEY")) {
    throw new Error("github_private_key_not_pkcs8");
  }
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    der.buffer as ArrayBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export async function createAppJwt(config: GithubAppConfig, nowMs: number): Promise<string> {
  const nowSec = Math.floor(nowMs / 1000);
  const header = b64urlJson({ alg: "RS256", typ: "JWT" });
  const payload = b64urlJson({ iss: config.appId, iat: nowSec - 60, exp: nowSec + 540 });
  const signingInput = `${header}.${payload}`;
  const key = await importPkcs8(config.privateKeyPkcs8Pem);
  const sig = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput)),
  );
  return `${signingInput}.${b64url(sig)}`;
}
