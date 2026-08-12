/**
 * A completion token authorises exactly one statement: "process P in thread T
 * ended". It rides in the wrapped command line, so the model can read it with
 * `ps` or from shell history — which is accepted, because the worst forgery it
 * enables is lying about its own process's exit code, something the model can
 * already do in prose. It must therefore never widen: no workspace scope, no
 * other thread, no other assertion.
 */
const COMPLETION_CONTEXT = "nadi-compute-completion-v1";

export interface CompletionTokenPayload {
  threadId: string;
  processId: string;
  exp: number; // epoch ms
}

const encoder = new TextEncoder();

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/").replace(/=+$/, "");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
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

/** Derive HMAC key material from BETTER_AUTH_SECRET without storing a separate secret. */
export async function deriveCompletionSecret(betterAuthSecret: string): Promise<string> {
  const material = encoder.encode(`${COMPLETION_CONTEXT}\0${betterAuthSecret}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", material));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function signCompletionToken(
  secret: string,
  payload: CompletionTokenPayload,
): Promise<string> {
  const body = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
  return `${body}.${bytesToBase64Url(sig)}`;
}

export async function verifyCompletionToken(
  secret: string,
  token: string,
  nowMs: number,
): Promise<CompletionTokenPayload | null> {
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
  let payload: CompletionTokenPayload;
  try {
    payload = JSON.parse(
      new TextDecoder().decode(base64UrlToBytes(body)),
    ) as CompletionTokenPayload;
  } catch {
    return null;
  }
  if (
    typeof payload.exp !== "number" ||
    payload.exp <= nowMs ||
    typeof payload.threadId !== "string" ||
    payload.threadId.length === 0 ||
    typeof payload.processId !== "string" ||
    payload.processId.length === 0
  ) {
    return null;
  }
  return payload;
}
