/**
 * Restore the public origin on a request that arrived through a TLS-terminating
 * proxy.
 *
 * The MCP OAuth provider is handed a callback URL built from `APP_BASE_URL`
 * (`WorkspaceMcpAgent.createMcpOAuthProvider`), and the Agents SDK matches the
 * redirect against it by **origin and pathname**
 * (`MCPClientManager.isCallbackRequest`). When something else terminates TLS
 * and speaks plain HTTP to the origin — exe.dev's proxy, Coolify, any reverse
 * proxy in front — the Worker sees `http://host/...` while the stored callback
 * says `https://host/...`. The origins differ, the match fails, and the request
 * falls through to the base `onRequest`, which answers "Not implemented" — a
 * message that describes the fall-through, not the cause.
 *
 * `APP_BASE_URL` is the canonical public origin on every platform, so trusting
 * it is correct rather than a celld workaround. Where the request already
 * carries the public origin (Cloudflare, or Caddy terminating TLS itself) this
 * returns null and the caller leaves the request untouched.
 *
 * Only the origin is replaced. Path, query and fragment are the OAuth
 * provider's, and `state`/`code` must survive verbatim.
 */
export function rewriteToPublicOrigin(url: URL, appBaseUrl: string | undefined): URL | null {
  if (!appBaseUrl) return null;

  let base: URL;
  try {
    base = new URL(appBaseUrl);
  } catch {
    // A malformed APP_BASE_URL must not take the callback down with it; the
    // unrewritten request still works wherever TLS is not being terminated
    // upstream.
    return null;
  }

  if (base.origin === url.origin) return null;

  // Host mismatches are somebody else's bug — a proxy pointed at the wrong
  // backend, or a request for a hostname this deployment does not serve.
  // Rewriting the host would paper over that; only the scheme is in scope.
  if (base.hostname !== url.hostname) return null;

  const rewritten = new URL(url);
  rewritten.protocol = base.protocol;
  rewritten.port = base.port;
  return rewritten;
}
