// One-command deploy to a celld fleet bucket.
//
// Usage:
//   pnpm celld:deploy                            # bucket/endpoint/region from env
//   pnpm celld:deploy -- --dry-run               # bundle locally, write nothing
//   pnpm celld:deploy -- --bucket s3://nadi --endpoint https://… --region us-east-1
//
// celld reads CELLD_BUCKET / S3_ENDPOINT / AWS_REGION itself, so exporting
// those works too; everything after `--` is forwarded verbatim to
// `celld deploy`. The config is always wrangler.celld.jsonc.
//
// celld itself is never vendored or installed by this script — it is a binary
// the operator installs (curl -fsSL https://celld.dev/install.sh | sh). We
// only fail loudly with the install hint when it is missing.
//
// esbuild: `celld deploy` shells out to esbuild and expects it on PATH, which
// it is not here — esbuild is a transitive dependency living in the pnpm
// store, not a declared one and not installed globally. So this script
// resolves a binary and names it in CELLD_ESBUILD, which keeps "install
// esbuild" off the operator's prerequisite list.
//
// Until celld v0.3.0 that variable pointed at scripts/celld-esbuild.mjs, a
// wrapper that appended `--alias:path=node:path` and friends: celld's bundler
// did not alias bare Node builtins the way wrangler's nodejs_compat does, and
// `mime-types` (transitive under `agents`) does `require('path')`, so the
// bundle failed outright without it. celld v0.3.0 accepts bare builtin
// specifiers (denoland/celld#157) and the wrapper is gone.

import { spawn } from "node:child_process";
import { accessSync, constants, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
  const root = join(repoRoot, "node_modules", ".pnpm");
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
    // No pnpm store; leave CELLD_ESBUILD unset and let celld find esbuild on
    // PATH, which is the documented arrangement.
  }
  return best;
}

// ESBUILD_BIN wins, then the pnpm store. Unset means "celld, use PATH".
const esbuild = process.env.ESBUILD_BIN ?? pnpmStoreEsbuild();

// `assets` in wrangler.celld.jsonc points at web/dist, and a MISSING directory
// is the quiet failure: celld deploys the Worker, the API answers normally, and
// every other route 404s with nothing in any log saying the SPA was never
// uploaded. `pnpm web:build` is a separate step from this one and is easy to
// skip, so check rather than discover it in a browser.
const assetsDir = join(repoRoot, "web", "dist");
try {
  if (!statSync(assetsDir).isDirectory() || readdirSync(assetsDir).length === 0) {
    throw new Error("empty");
  }
} catch {
  console.error(
    "celld-deploy: web/dist is missing or empty, and wrangler.celld.jsonc serves\n" +
      "  the SPA from it. Deploying now would upload a Worker with no static\n" +
      "  assets: the API would work and every other route would 404.\n" +
      "  Run `pnpm web:build` first.",
  );
  process.exit(1);
}

const celldBin = process.env.CELLD_BIN ?? "celld";
// pnpm passes the `--` separator through to the script; drop it so the
// forwarded args are exactly what the operator wrote after `--`.
const passthrough = process.argv.slice(2);
if (passthrough[0] === "--") passthrough.shift();
const args = ["deploy", "--config", "wrangler.celld.jsonc", ...passthrough];

const child = spawn(celldBin, args, {
  cwd: repoRoot,
  stdio: "inherit",
  env: { ...process.env, ...(esbuild ? { CELLD_ESBUILD: esbuild } : {}) },
});

child.on("error", (err) => {
  if (err.code === "ENOENT") {
    console.error(
      "celld-deploy: `celld` is not installed or not on PATH.\n" +
        "  Install it with: curl -fsSL https://celld.dev/install.sh | sh\n" +
        "  (or set CELLD_BIN to the celld binary).",
    );
  } else {
    console.error(`celld-deploy: failed to run celld: ${err.message}`);
  }
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
