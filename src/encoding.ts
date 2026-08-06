/**
 * base64url (RFC 4648 §5) for byte arrays: the unpadded, URL-safe alphabet that
 * JWTs, VAPID keys, push subscription keys and signed view tokens all speak.
 *
 * Four copies of this pair had accumulated — `artifacts/view-token.ts`,
 * `github/state.ts`, `github/jwt.ts` and `notifications/web-push.ts` — written
 * in two different styles that computed the decode padding differently. They
 * agreed, but nothing made them agree, and a wrong padding length is a bug that
 * only shows up on inputs whose length hits the wrong residue class.
 *
 * Note this is the *bytes* codec. Encoding a string means choosing an encoding
 * for it first; call sites that base64 a JSON string (thread cursors, web-tool
 * cursors) are doing something different and deliberately stay separate.
 */

/** Bytes → unpadded base64url. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/**
 * base64url → bytes. Accepts input with or without `=` padding: a base64url
 * string is canonically unpadded, but callers receive these from elsewhere
 * (VAPID keys pasted from other tools, JWTs from other issuers) and padded
 * input is common enough in the wild to be worth accepting.
 */
export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/").replace(/=+$/, "");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
