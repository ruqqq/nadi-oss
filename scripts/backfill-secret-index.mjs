#!/usr/bin/env node
// Build workspaces/<id>/secret-index from the secret keys already in SECRETS_KV.
//
// One-off, same contract as deploy/celld/backfill-secret-index.sh: run it once,
// right after deploying the release that introduced the index and before
// serving traffic. Idempotent.
//
// Cloudflare KV has no list-prefix length limit, so this lists the full
// `workspaces/` space in one pass and groups locally.
//
//   node scripts/backfill-secret-index.mjs --binding SECRETS_KV --remote
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const binding = args[args.indexOf("--binding") + 1] ?? "SECRETS_KV";
const remote = args.includes("--remote") ? ["--remote"] : [];

const wrangler = (...rest) =>
  execFileSync("pnpm", ["exec", "wrangler", "kv", ...rest, "--binding", binding, ...remote], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

const keys = JSON.parse(wrangler("key", "list", "--prefix", "workspaces/")).map((k) => k.name);
const secretKeys = keys.filter((k) => k.includes("/secrets/"));
if (secretKeys.length === 0) {
  console.log("no secret keys found — nothing to backfill");
  process.exit(0);
}

const byWorkspace = new Map();
for (const key of secretKeys) {
  const [, workspaceId, name] = key.match(/^workspaces\/([^/]+)\/secrets\/(.+)$/) ?? [];
  if (!workspaceId) continue;
  if (!byWorkspace.has(workspaceId)) byWorkspace.set(workspaceId, []);
  byWorkspace.get(workspaceId).push({ key, name });
}

for (const [workspaceId, secrets] of byWorkspace) {
  const entries = {};
  for (const { key, name } of secrets) {
    // updated_at is plaintext beside the ciphertext, so no KEK is needed here.
    const record = JSON.parse(wrangler("key", "get", key));
    entries[name] = { updated_at: record.updated_at };
  }
  const indexKey = `workspaces/${workspaceId}/secret-index`;
  wrangler("key", "put", indexKey, JSON.stringify({ version: 1, entries }));
  console.log(`${workspaceId}: ${Object.keys(entries).length} secrets indexed`);
}
console.log("backfill complete");
