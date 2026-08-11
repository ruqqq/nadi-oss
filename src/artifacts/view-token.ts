import { base64UrlToBytes, bytesToBase64Url } from "../encoding";

export interface ArtifactViewTokenPayload {
  artifactId: string;
  exp: number; // epoch ms
}

const ARTIFACT_VIEW_CONTEXT = "nadi-artifact-view-v1";
const encoder = new TextEncoder();

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** Derive HMAC key material from BETTER_AUTH_SECRET without storing a separate secret. */
export async function deriveArtifactViewSecret(betterAuthSecret: string): Promise<string> {
  const material = encoder.encode(`${ARTIFACT_VIEW_CONTEXT}\0${betterAuthSecret}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", material));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function signArtifactViewToken(
  secret: string,
  payload: ArtifactViewTokenPayload,
): Promise<string> {
  const body = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
  return `${body}.${bytesToBase64Url(sig)}`;
}

export async function verifyArtifactViewToken(
  secret: string,
  token: string,
  nowMs: number,
): Promise<ArtifactViewTokenPayload | null> {
  const dot = token.indexOf(".");
  if (dot === -1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let key: CryptoKey;
  try {
    key = await hmacKey(secret);
  } catch {
    return null;
  }
  let ok: boolean;
  try {
    ok = await crypto.subtle.verify(
      "HMAC",
      key,
      base64UrlToBytes(sig) as BufferSource,
      encoder.encode(body),
    );
  } catch {
    return null;
  }
  if (!ok) return null;
  let payload: ArtifactViewTokenPayload;
  try {
    payload = JSON.parse(
      new TextDecoder().decode(base64UrlToBytes(body)),
    ) as ArtifactViewTokenPayload;
  } catch {
    return null;
  }
  if (
    typeof payload.exp !== "number" ||
    payload.exp <= nowMs ||
    typeof payload.artifactId !== "string" ||
    payload.artifactId.length === 0
  ) {
    return null;
  }
  return payload;
}
