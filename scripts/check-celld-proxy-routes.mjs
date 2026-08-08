#!/usr/bin/env node
// Fail if src/index.ts routes a path that deploy/celld/Caddyfile does not
// proxy to the Worker.
//
// On Cloudflare the assets binding and the Worker share one origin, so a new
// route just works. On celld they do not: celld has no assets binding and
// serves no static files, so Caddy owns the split, and the list of Worker
// paths in the Caddyfile is hand-copied from src/index.ts.
//
// When those drift, nothing errors. Caddy falls through to `try_files {path}
// /index.html` and answers the unproxied route with the SPA shell and a 200 —
// so the failure surfaces as a component behaving strangely against HTML it
// tried to parse as JSON, with no 404 and nothing in any log pointing at the
// proxy. That is a bad afternoon, and it is entirely mechanical to prevent.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const INDEX = "src/index.ts";
const CADDYFILE = "deploy/celld/Caddyfile";

const source = readFileSync(INDEX, "utf8");

/**
 * Resolve `startsWith(SOME_CONSTANT)` by finding the constant's definition
 * anywhere in src/. Without this, VOICE_PARTY_PREFIX reads as "no route" and
 * the check silently stops covering the voice socket.
 */
function resolveConstant(name) {
  const hit = execFileSync("grep", ["-rhoE", `export const ${name} = "[^"]+"`, "src"], {
    encoding: "utf8",
  }).trim();
  const value = hit.match(/"([^"]+)"/)?.[1];
  if (!value) throw new Error(`could not resolve ${name} — it is used as a route in ${INDEX}`);
  return value;
}

const routes = new Set();
for (const [, literal] of source.matchAll(/pathname\.startsWith\("([^"]+)"\)/g)) {
  routes.add(literal);
}
for (const [, literal] of source.matchAll(/pathname === "([^"]+)"/g)) {
  routes.add(literal);
}
for (const [, ident] of source.matchAll(/pathname\.startsWith\(([A-Z_][A-Z0-9_]*)\)/g)) {
  routes.add(resolveConstant(ident));
}

if (routes.size === 0) {
  // The regexes above are the whole check. If a refactor changes how routing
  // is expressed, finding nothing must fail loudly rather than pass silently.
  console.error(`No routes found in ${INDEX} — this check has stopped working.`);
  process.exit(1);
}

const caddyfile = readFileSync(CADDYFILE, "utf8");
const matcher = caddyfile.match(/^\s*@worker\s+path\s+(.+)$/m);
if (!matcher) {
  console.error(`No '@worker path …' matcher found in ${CADDYFILE}.`);
  process.exit(1);
}
const patterns = matcher[1].trim().split(/\s+/);

/** Caddy `path` semantics: `/x/*` is a prefix match, anything else is exact. */
function covers(pattern, route) {
  if (pattern.endsWith("*")) return route.startsWith(pattern.slice(0, -1));
  return pattern === route;
}

const uncovered = [...routes].filter((route) => !patterns.some((p) => covers(p, route)));

if (uncovered.length) {
  console.error(`Routes handled by ${INDEX} that ${CADDYFILE} does not proxy:\n`);
  for (const route of uncovered.sort()) console.error(`  ${route}`);
  console.error(`\nAdd each to the '@worker path' matcher in ${CADDYFILE}.`);
  console.error("Until then celld answers them with index.html and a 200, not a 404.");
  process.exit(1);
}

console.log(
  `celld proxy routes: OK (${routes.size} routes covered by ${patterns.length} patterns)`,
);
