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
// Targeting matters more than it looks. `--binding NAME` resolves against
// whatever wrangler config is in scope, and THIS repo's wrangler.jsonc carries
// a placeholder namespace id (all zeros) because it is the self-host template —
// so a bare `--binding SECRETS_KV --remote` run from here does not address a
// real deployment. Name the namespace explicitly:
//
//   node scripts/backfill-secret-index.mjs --namespace-id <id> --remote
//   node scripts/backfill-secret-index.mjs --binding SECRETS_KV --config path/to/wrangler.prod.jsonc --remote
//
// Rehearse before committing to it:
//
//   ... --dry-run              print every index that would be written, write nothing
//   ... --only <workspaceId>   restrict to one workspace
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? null : (args[at + 1] ?? null);
};

const namespaceId = flag("--namespace-id");
const configPath = flag("--config");
const binding = flag("--binding") ?? "SECRETS_KV";
const remote = args.includes("--remote") ? ["--remote"] : [];
const dryRun = args.includes("--dry-run");
const only = flag("--only");

// The placeholder in this repo's own wrangler.jsonc. Addressing it is never
// what anyone meant, and wrangler's failure would come back as a confusing
// 404 rather than "you targeted the template".
const PLACEHOLDER_NAMESPACE_ID = "0".repeat(32);
if (namespaceId === PLACEHOLDER_NAMESPACE_ID) {
  console.error(
    "error: that is the placeholder namespace id from this repo's wrangler.jsonc, not a real namespace",
  );
  process.exit(2);
}
// A --binding with no --config silently inherits this repo's template config.
// Refuse it against a remote namespace rather than backfill into nowhere.
if (remote.length > 0 && namespaceId === null && configPath === null) {
  console.error(
    "error: --remote needs an explicit target: pass --namespace-id <id>, or --config <wrangler config> alongside --binding",
  );
  process.exit(2);
}

const target = namespaceId !== null ? ["--namespace-id", namespaceId] : ["--binding", binding];
const config = configPath !== null ? ["--config", configPath] : [];

const wrangler = (...rest) =>
  execFileSync("pnpm", ["exec", "wrangler", "kv", ...rest, ...target, ...config, ...remote], {
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
    if (only !== null && workspaceId !== only) continue;
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
    const body = JSON.stringify({ version: 1, entries });
    if (dryRun) {
      console.log(`[dry-run] ${indexKey} <- ${body}`);
      continue;
    }
    wrangler("key", "put", indexKey, body);
    console.log(`${workspaceId}: ${Object.keys(entries).length} secrets indexed`);
  }
  console.log(dryRun ? "dry run complete — nothing was written" : "backfill complete");
  if (anyFailed) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
