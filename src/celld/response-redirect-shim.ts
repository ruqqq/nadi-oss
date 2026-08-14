/**
 * `Response.redirect` shim.
 *
 * celld's runtime does not implement the static `Response.redirect`, so every
 * redirect throws `TypeError: Response.redirect is not a function`. That is not
 * a corner: it breaks the canonical-host redirect in `src/index.ts`, the whole
 * GitHub App connect/callback flow in `src/http/github-routes.ts`, and — the
 * way this was found — the MCP OAuth callback response inside the `agents` SDK
 * (`handleOAuthCallbackResponse`), which we cannot edit.
 *
 * A shim installed on the global therefore fixes call sites we own AND the
 * SDK's in one place, which a local helper could not.
 *
 * PROBED, NOT PLATFORM-CHECKED, and probed by *calling* it. `typeof
 * Response.redirect === "function"` is the proxy, not the operation — celld
 * v0.2.0 already taught this once, by implementing RSA `importKey` while
 * refusing `sign`, so a probe that stopped at the import reported a capability
 * the runtime did not have and broke every GitHub App JWT (see the RS256 probe
 * in `src/github/jwt.ts`). A runtime does not gain a capability atomically, so
 * this invokes the real thing and checks the response it gets back.
 *
 * On Cloudflare the probe succeeds and nothing is installed.
 */

/** Redirect statuses the platform allows; anything else is a RangeError. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function nativeRedirectWorks(): boolean {
  try {
    const probe = Response.redirect("https://example.invalid/probe", 302);
    return probe.status === 302 && probe.headers.get("location") !== null;
  } catch {
    return false;
  }
}

/**
 * Install the shim if the runtime needs it. Idempotent, and safe to call from
 * module scope — it runs once per isolate, before any handler.
 */
export function installResponseRedirectShim(): boolean {
  if (typeof Response !== "function") return false;
  if (nativeRedirectWorks()) return false;

  const redirect = (url: string | URL, status = 302): Response => {
    // Matches the platform's contract rather than approximating it: an invalid
    // status is a RangeError and a relative URL is a TypeError, so a caller
    // that is wrong stays wrong in the same way on both platforms instead of
    // silently working on one.
    if (!REDIRECT_STATUSES.has(status)) {
      throw new RangeError(`Invalid redirect status: ${status}`);
    }
    const location = new URL(url).toString();
    return new Response(null, { status, headers: { Location: location } });
  };

  Object.defineProperty(Response, "redirect", {
    value: redirect,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  return true;
}
