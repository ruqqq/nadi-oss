// One-command deploy to a celld fleet bucket. The esbuild alias requirement is
// handled here — see scripts/celld-esbuild.mjs — so nothing about esbuild is a
// prerequisite the operator has to reassemble.
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

import { spawn } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wrapper = join(repoRoot, "scripts", "celld-esbuild.mjs");

// celld spawns CELLD_ESBUILD directly, so the wrapper must be executable even
// if git lost the mode bit on some checkout.
if (existsSync(wrapper)) chmodSync(wrapper, 0o755);

const celldBin = process.env.CELLD_BIN ?? "celld";
// pnpm passes the `--` separator through to the script; drop it so the
// forwarded args are exactly what the operator wrote after `--`.
const passthrough = process.argv.slice(2);
if (passthrough[0] === "--") passthrough.shift();
const args = ["deploy", "--config", "wrangler.celld.jsonc", ...passthrough];

const child = spawn(celldBin, args, {
  cwd: repoRoot,
  stdio: "inherit",
  env: { ...process.env, CELLD_ESBUILD: wrapper },
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
