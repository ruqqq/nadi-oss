// Egress proxy — a zero-dependency Node streaming relay.
//
// Purpose: some model providers refuse traffic that egresses from a Cloudflare
// Worker. ChatGPT's Codex backend (chatgpt.com/backend-api/codex) sits behind
// Cloudflare Bot Management and 403s it outright; OpenCode Zen throttles its
// free models per egress IP, and a Worker's IP is shared. This proxy runs on an
// exe.dev VM whose IP passes both and relays the (already authenticated)
// request through to the upstream. It holds no credentials: the caller (the
// Worker) supplies the provider auth headers per request. Access is gated by
// exe.dev's VM-token proxy in front of this server.
//
// Routing: the first path segment names the route; the rest is appended to that
// route's upstream base. `/opencode-zen/chat/completions` reaches
// `https://opencode.ai/zen/v1/chat/completions`. Unknown prefixes 404 — the
// upstream set is closed, so this can never be pointed at an arbitrary host.
//
// Run: PORT=8088 node server.mjs

import http from "node:http";
import { Readable } from "node:stream";

// The only place a provider is defined. Request-header allowlists are per route
// on purpose: everything else (host, x-exedev-*, x-forwarded-*, hop-by-hop) is
// dropped, and one upstream's headers must not reach another's.
export const ROUTES = {
  "openai-oauth": {
    upstream: "https://chatgpt.com/backend-api/codex",
    requestHeaders: [
      "authorization",
      "chatgpt-account-id",
      "openai-beta",
      "content-type",
      "accept",
    ],
  },
  "opencode-zen": {
    upstream: "https://opencode.ai/zen/v1",
    requestHeaders: ["authorization", "content-type", "accept"],
  },
};

// Response headers we relay back. The body is streamed, so we let Node manage
// transfer-encoding/content-length and avoid forwarding hop-by-hop headers.
// retry-after/-ms are forwarded so the caller's backoff can see a throttle.
const RESPONSE_HEADER_ALLOWLIST = new Set([
  "content-type",
  "cache-control",
  "retry-after",
  "retry-after-ms",
]);

/**
 * Resolve a request path to its route and upstream URL, or null when the first
 * segment names no known route. A bare prefix with no trailing path is also a
 * miss — every upstream call targets a real endpoint under the base.
 */
export function resolveRoute(reqUrl, routes = ROUTES) {
  const [pathname, search = ""] = splitQuery(reqUrl);
  const match = /^\/([^/]+)(\/.*)$/.exec(pathname);
  if (!match) return null;
  const [, name, rest] = match;
  const route = Object.hasOwn(routes, name) ? routes[name] : undefined;
  if (!route) return null;
  const base = withoutTrailingSlash(route.upstream);
  return { name, route, upstreamUrl: `${base}${rest}${search}` };
}

export function filterRequestHeaders(headers, allowlist) {
  const allowed = new Set(allowlist);
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (allowed.has(lower)) {
      out[lower] = Array.isArray(value) ? value.join(", ") : value;
    }
  }
  return out;
}

export function filterResponseHeaders(headers) {
  const out = {};
  const entries =
    typeof headers.forEach === "function" && !Array.isArray(headers)
      ? (() => {
          const acc = [];
          headers.forEach((v, k) => acc.push([k, v]));
          return acc;
        })()
      : Object.entries(headers);
  for (const [key, value] of entries) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (RESPONSE_HEADER_ALLOWLIST.has(lower)) out[lower] = value;
  }
  return out;
}

async function handleRequest(req, res) {
  const started = Date.now();
  const method = req.method ?? "GET";
  const path = req.url ?? "/";

  if (method === "GET" && path === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }

  const resolved = resolveRoute(path);
  if (!resolved) {
    log(method, path, 404, started, undefined, "unknown_route");
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("unknown route");
    return;
  }

  const headers = filterRequestHeaders(req.headers, resolved.route.requestHeaders);

  const init = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(req);
    init.duplex = "half";
  }

  let upstream;
  try {
    upstream = await fetch(resolved.upstreamUrl, init);
  } catch (error) {
    log(
      method,
      path,
      502,
      started,
      resolved.name,
      error instanceof Error ? error.message : String(error),
    );
    res.writeHead(502, { "content-type": "text/plain" });
    res.end("bad gateway");
    return;
  }

  res.writeHead(upstream.status, filterResponseHeaders(upstream.headers));
  if (upstream.body) {
    Readable.fromWeb(upstream.body).pipe(res);
    res.on("close", () => log(method, path, upstream.status, started, resolved.name));
  } else {
    res.end();
    log(method, path, upstream.status, started, resolved.name);
  }
}

function log(method, path, status, started, route, error) {
  const entry = {
    ts: new Date().toISOString(),
    event: "egress_proxy.request",
    method,
    path,
    status,
    duration_ms: Date.now() - started,
  };
  if (route) entry.route = route;
  if (error) entry.error = error;
  // Never log header values or bodies — they carry the provider credential.
  console.log(JSON.stringify(entry));
}

function splitQuery(reqUrl) {
  const index = reqUrl.indexOf("?");
  return index === -1 ? [reqUrl, ""] : [reqUrl.slice(0, index), reqUrl.slice(index)];
}

function withoutTrailingSlash(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

// Only start the server when run directly, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8088);
  http
    .createServer((req, res) => void handleRequest(req, res))
    .listen(port, "0.0.0.0", () => {
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          event: "egress_proxy.listening",
          port,
          routes: Object.keys(ROUTES),
        }),
      );
    });
}
