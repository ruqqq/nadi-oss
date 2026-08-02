#!/usr/bin/env node
/**
 * Guards the "no mock code in production builds" invariant.
 *
 * Two checks:
 *  1. Source: no file under web/src/ — other than the mock tree itself and the
 *     dev-only mock entry — may import `msw` or anything under `mocks/`.
 *     The production bundle is reached from web/index.html, so a single import
 *     edge from product code into web/src/mocks/ pulls MSW and the fixtures
 *     into the shipped app.
 *  2. Build output: when web/dist/ exists, it must contain no mock entry
 *     document and no chunk that references the mock entry.
 *
 * Why a script and not an oxlint rule: oxlint 0.13.2 does NOT implement
 * `no-restricted-imports`. Verified empirically — with the rule configured
 * against a matching import oxlint reported nothing, while the config was
 * demonstrably being read (disabling `no-unused-vars` moved the active rule
 * count 97 -> 96). A lint-based guard here would be permanently green.
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const webSrc = join(repoRoot, "web", "src");
const webDist = join(repoRoot, "web", "dist");

/** Paths (relative to web/src) that are allowed to import mocks. */
const ALLOWED = ["mocks", "mock-main.tsx"];

const SOURCE_EXT = /\.(ts|tsx|mts|cts)$/;

/** All import-ish specifier positions: static, re-export, dynamic, require. */
const SPECIFIER_PATTERNS = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];

/** `msw`, `msw/browser`, `./mocks/store`, `@/mocks/x`, `../../mocks` */
function isMockSpecifier(spec) {
  if (spec === "msw" || spec.startsWith("msw/")) return true;
  const segments = spec.split("/");
  return segments.includes("mocks") || segments.at(-1) === "mocks";
}

function isAllowed(relPath) {
  const first = relPath.split(sep)[0];
  return ALLOWED.includes(first) || ALLOWED.includes(relPath);
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

const violations = [];

if (existsSync(webSrc)) {
  for (const file of walk(webSrc)) {
    if (!SOURCE_EXT.test(file)) continue;
    const relToSrc = relative(webSrc, file);
    if (isAllowed(relToSrc)) continue;

    const source = readFileSync(file, "utf8");
    const lines = source.split("\n");
    const seen = new Set();

    for (const pattern of SPECIFIER_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(source)) !== null) {
        const spec = match[1];
        if (!spec || !isMockSpecifier(spec)) continue;
        const line = source.slice(0, match.index).split("\n").length;
        const key = `${line}:${spec}`;
        if (seen.has(key)) continue;
        seen.add(key);
        violations.push({
          file: relative(repoRoot, file),
          line,
          spec,
          text: (lines[line - 1] ?? "").trim(),
        });
      }
    }
  }
}

violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

// --- Build output ---------------------------------------------------------

const distProblems = [];

if (existsSync(webDist) && statSync(webDist).isDirectory()) {
  for (const file of walk(webDist)) {
    const rel = relative(repoRoot, file);
    const base = rel.split(sep).at(-1) ?? "";
    if (base === "mock.html") {
      distProblems.push(`${rel} — the mock entry document must never be a build input`);
      continue;
    }
    if (/\.(js|html)$/.test(base) && readFileSync(file, "utf8").includes("mock-main")) {
      distProblems.push(`${rel} — references the mock entry (mock-main)`);
    }
  }
}

// mockServiceWorker.js: written by `msw init` into web/public/, which Vite
// copies verbatim into dist. It is gitignored, so it is never present in a CI
// or deploy build (both build from a fresh checkout) — hence a warning, not a
// failure, for local builds where a developer has run `msw init`. It is inert
// either way: a service worker script does nothing unless registered, and only
// the Workbox-built sw.ts is ever registered (web/src/lib/register-sw.ts).
const strayMswWorker = join(webDist, "mockServiceWorker.js");
const warnings = existsSync(strayMswWorker)
  ? [
      "web/dist/mockServiceWorker.js is present (local build only; gitignored, inert unless registered)",
    ]
  : [];

// --- Report ---------------------------------------------------------------

for (const warning of warnings) console.warn(`warning: ${warning}`);

if (violations.length === 0 && distProblems.length === 0) {
  console.log("mock isolation: OK");
  process.exit(0);
}

console.error("mock isolation: FAILED\n");

if (violations.length > 0) {
  console.error("Product code must not import mock code (msw / mocks/):");
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  imports "${v.spec}"`);
    console.error(`    ${v.text}`);
  }
  console.error("");
}

if (distProblems.length > 0) {
  console.error("Mock artifacts found in the production build:");
  for (const p of distProblems) console.error(`  ${p}`);
  console.error("");
}

process.exit(1);
