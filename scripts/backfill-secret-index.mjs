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

// A missing/invalid updated_at must never silently become {} — that entry
// fails parseWorkspaceSecretIndex on read and takes out the whole workspace's
// index. Mirrors the celld script's Python KeyError, which aborts loudly on
// the same input rather than filling in a fabricated timestamp.
export function validatedUpdatedAt(record) {
  const value = record?.updated_at;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function main() {
  const keys = JSON.parse(wrangler("key", "list", "--prefix", "workspaces/")).map((k) => k.name);
  const secretKeys = keys.filter((k) => k.includes("/secrets/"));
  // A workspace with a DEK but zero secret keys (e.g. its last secret was
  // deleted) never shows up in secretKeys, but it still needs an index — a
  // DEK with no index reads as "predates the index" and index_missing throws
  // forever, with no runtime repair path. The dek listing is already in hand
  // from the same `workspaces/` scan; this only changes how it is grouped.
  const dekWorkspaceIds = new Set();
  for (const key of keys) {
    const [, workspaceId] = key.match(/^workspaces\/([^/]+)\/dek$/) ?? [];
    if (workspaceId) dekWorkspaceIds.add(workspaceId);
  }

  if (secretKeys.length === 0 && dekWorkspaceIds.size === 0) {
    console.log("no secret keys found — nothing to backfill");
    process.exit(0);
  }

  const byWorkspace = new Map();
  for (const key of secretKeys) {
    const match = key.match(/^workspaces\/([^/]+)\/secrets\/([\s\S]+)$/);
    if (!match) {
      console.error(`error: key ${key} looks like a secret key but does not parse — aborting`);
      process.exit(1);
    }
    const [, workspaceId, name] = match;
    if (!byWorkspace.has(workspaceId)) byWorkspace.set(workspaceId, []);
    byWorkspace.get(workspaceId).push({ key, name });
  }

  // Every DEK-only workspace (no secrets at all) still needs an empty index.
  for (const workspaceId of dekWorkspaceIds) {
    if (!byWorkspace.has(workspaceId)) byWorkspace.set(workspaceId, []);
  }

  let anyFailed = false;
  for (const [workspaceId, secrets] of byWorkspace) {
    const entries = {};
    let workspaceFailed = false;
    for (const { key, name } of secrets) {
      // updated_at is plaintext beside the ciphertext, so no KEK is needed here.
      const record = JSON.parse(wrangler("key", "get", key));
      const updatedAt = validatedUpdatedAt(record);
      if (updatedAt === null) {
        console.error(
          `error: workspace ${workspaceId} key ${key} has no valid updated_at — refusing to write an index for this workspace`,
        );
        workspaceFailed = true;
        anyFailed = true;
        break;
      }
      entries[name] = { updated_at: updatedAt };
    }
    if (workspaceFailed) continue;
    const indexKey = `workspaces/${workspaceId}/secret-index`;
    wrangler("key", "put", indexKey, JSON.stringify({ version: 1, entries }));
    console.log(`${workspaceId}: ${Object.keys(entries).length} secrets indexed`);
  }
  console.log("backfill complete");
  if (anyFailed) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
