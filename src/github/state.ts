export interface GithubStatePayload {
  workspaceId: string;
  userId: string;
  nonce: string;
  exp: number; // epoch ms
}

const encoder = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

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
  const body = b64url(encoder.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
  return `${body}.${b64url(sig)}`;
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
      b64urlDecode(sig) as BufferSource,
      encoder.encode(body),
    );
  } catch {
    return null;
  }
  if (!ok) return null;
  let payload: GithubStatePayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as GithubStatePayload;
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
