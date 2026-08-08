#!/usr/bin/env node
// celld's deploy step shells out to the binary named by CELLD_ESBUILD with the
// exact arguments it would pass to esbuild. Wrangler's nodejs_compat aliases
// bare node builtins for you; celld's bundler does not, and `mime-types`
// (transitive under `agents`) does `require('path')` — so the bundle fails
// outright without a shim. This wrapper rewrites those imports to `node:*`
// specifiers, which celld already externalizes at bundle time and provides at
// runtime, then delegates to a real esbuild.
//
// Point CELLD_ESBUILD at this file (scripts/celld-deploy.mjs does that for
// you). The real esbuild is resolved, in order, from:
//   1. the ESBUILD_BIN environment variable, if set;
//   2. the repo's pnpm store (node_modules/.pnpm/esbuild@*/…), newest first;
//   3. `esbuild` on PATH.
// Nothing is vendored and esbuild is not a dependency of this project — a
// global install (npm install -g esbuild) also works, it just is not required.

import { spawn } from "node:child_process";
import { accessSync, constants, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Bare builtins workerd's nodejs_compat would have aliased for us. celld's
// runtime implements these node: modules (assert, buffer, events, path,
// stream, util fully; crypto, fs, zlib partially), so the rewrite is safe.
const ALIASES = [
  "assert",
  "buffer",
  "crypto",
  "events",
  "fs",
  "os",
  "path",
  "process",
  "stream",
  "url",
  "util",
  "zlib",
];

const scriptDir = dirname(fileURLToPath(import.meta.url));

function executable(p) {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

// Newest esbuild in the pnpm store wins; versions are compared as [major,
// minor, patch] so 0.28.1 sorts above 0.25.12.
function pnpmStoreEsbuild() {
  const root = join(scriptDir, "..", "node_modules", ".pnpm");
  let best = null;
  let bestVersion = [-1, -1, -1];
  try {
    for (const entry of readdirSync(root)) {
      const match = /^esbuild@(\d+)\.(\d+)\.(\d+)$/.exec(entry);
      if (!match) continue;
      const candidate = join(root, entry, "node_modules", "esbuild", "bin", "esbuild");
      if (!executable(candidate)) continue;
      const version = match.slice(1).map(Number);
      if (
        version[0] > bestVersion[0] ||
        (version[0] === bestVersion[0] && version[1] > bestVersion[1]) ||
        (version[0] === bestVersion[0] &&
          version[1] === bestVersion[1] &&
          version[2] > bestVersion[2])
      ) {
        best = candidate;
        bestVersion = version;
      }
    }
  } catch {
    // No pnpm store; fall through to PATH.
  }
  return best;
}

function resolveEsbuild() {
  const fromEnv = process.env.ESBUILD_BIN;
  if (fromEnv && executable(fromEnv)) return fromEnv;
  const fromStore = pnpmStoreEsbuild();
  if (fromStore) return fromStore;
  // PATH resolution happens inside spawn; we can only report ENOENT there.
  return "esbuild";
}

// Alias flags are appended so they win over anything the caller passed (celld
// passes no aliases, so in practice the list is exactly ours).
const esbuild = resolveEsbuild();
const child = spawn(
  esbuild,
  [...process.argv.slice(2), ...ALIASES.map((m) => `--alias:${m}=node:${m}`)],
  {
    stdio: "inherit",
  },
);

child.on("error", (err) => {
  if (err.code === "ENOENT") {
    console.error(
      `celld-esbuild: no esbuild binary found (tried ${esbuild}).\n` +
        "Install it globally (`npm install -g esbuild`) or set ESBUILD_BIN to an esbuild binary.",
    );
  } else {
    console.error(`celld-esbuild: failed to run ${esbuild}: ${err.message}`);
  }
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    // Match esbuild's own convention: killed by a signal, die the same way.
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
