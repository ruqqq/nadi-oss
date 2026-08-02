/**
 * Legacy-host redirect. A deployment that has moved to a custom domain keeps
 * its old hostname reachable, so anything still pointing there (bookmarks, old
 * links, a stale PWA start_url) lands on the canonical one instead of serving a
 * second origin — two origins mean two sets of cookies, caches, and service
 * worker registrations for the same app.
 *
 * Both halves are deployment-specific, so they are configuration rather than
 * constants: a self-hosted instance has no legacy host and gets no redirect.
 */
export interface CanonicalHostEnv {
  /** Host to send traffic to, e.g. "app.example.com". Unset disables the redirect. */
  CANONICAL_HOST?: string;
  /** Comma-separated hosts to redirect away from. Unset disables the redirect. */
  LEGACY_HOSTS?: string;
}

/**
 * The URL to redirect to, or null to serve the request normally. Null whenever
 * either half is unconfigured, when the host isn't a legacy one, or when the
 * request already targets the canonical host (which would otherwise loop).
 */
export function canonicalRedirectUrl(url: URL, env: CanonicalHostEnv): string | null {
  const canonical = (env.CANONICAL_HOST ?? "").trim().toLowerCase();
  if (canonical === "") return null;

  const hostname = url.hostname.toLowerCase();
  if (hostname === canonical) return null;

  const legacy = (env.LEGACY_HOSTS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  if (!legacy.includes(hostname)) return null;

  const next = new URL(url.toString());
  next.hostname = canonical;
  // `URL.hostname` is a lenient setter: a value carrying a scheme or a port
  // ("https://app.example.com", "app.example.com:443") is silently IGNORED,
  // which would return the request's own URL and 308 it to itself — an infinite
  // redirect for the whole legacy origin. Refuse to redirect instead.
  if (next.hostname !== canonical) return null;
  next.protocol = "https:";
  // The custom domain is on 443, so a stale :8787-style port from the legacy
  // origin must not survive the hop.
  next.port = "";
  return next.toString();
}
