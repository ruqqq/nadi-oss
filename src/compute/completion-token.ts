import { base64UrlToBytes, bytesToBase64Url } from "../encoding";

/**
 * Authorises exactly ONE statement: "process P in thread T ended". Scoped to a
 * single (threadId, processId) pair, with no workspace scope and no other
 * capability, because it rides in the wrapped command line where the model can
 * read it via `ps` — the worst forgery available is lying about its own
 * process's exit code, which it can already do in prose.
 *
 * NOT single-use: verification is stateless, so the token is replayable until
 * `exp`. Replay is harmless because the consuming route is idempotent — the
 * ledger row goes terminal once and a second report is collapsed, not
 * re-delivered. Do not rely on this module for at-most-once.
 */
const COMPLETION_CONTEXT = "nadi-compute-completion-v1";

export interface CompletionTokenPayload {
  threadId: string;
  processId: string;
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
