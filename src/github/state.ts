import { base64UrlToBytes, bytesToBase64Url } from "../encoding";

export interface GithubStatePayload {
  workspaceId: string;
  userId: string;
  nonce: string;
  exp: number; // epoch ms
}

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

export async function signGithubState(
  secret: string,
  payload: GithubStatePayload,
): Promise<string> {
  const body = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
  return `${body}.${bytesToBase64Url(sig)}`;
}

export async function verifyGithubState(
  secret: string,
  token: string,
  nowMs: number,
): Promise<GithubStatePayload | null> {
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
  let payload: GithubStatePayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(body))) as GithubStatePayload;
  } catch {
    return null;
  }
  if (
    typeof payload.exp !== "number" ||
    payload.exp <= nowMs ||
    typeof payload.workspaceId !== "string" ||
    typeof payload.userId !== "string" ||
    typeof payload.nonce !== "string"
  ) {
    return null;
  }
  return payload;
}
