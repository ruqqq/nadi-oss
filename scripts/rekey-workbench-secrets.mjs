#!/usr/bin/env node
// Move workbench-scoped sandbox secrets into the agent namespace:
//
//     sbxenv-env:<workbenchId>:<VAR>   ->   sbxenv-ag:<agentId>:<VAR>
//
// THIS IS CRYPTO, NOT A RENAME. `secretAad(workspaceId, name)` authenticates
// the variable NAME (src/secrets/kv-store.ts), and the name embeds the scope id
// — so a key rename produces a record that decrypts to nothing. Every value is
// decrypted under its old AAD and re-encrypted under the new one.
//
// RUN THIS BEFORE the deploy that applies migration 0067. It derives the
// workbench -> agent mapping from the PRE-migration D1, by the same rules the
// migration uses in SQL (see `deriveAgentIdForWorkbench` below and
// `__wb_agent_map` there). Once `workbenches` is dropped the mapping cannot be
// recovered from the database.
//
//   node scripts/rekey-workbench-secrets.mjs --plan   --config ... --remote
//   node scripts/rekey-workbench-secrets.mjs --apply  --config ... --remote
//   node scripts/rekey-workbench-secrets.mjs --verify --config ... --remote
//
//   --plan     read-only. Prints the mapping, every secret that would move, the
//              skill-name collisions the migration will leave agent-private, and
//              anything it CANNOT move. Writes nothing. Run this first.
//   --apply    performs the re-key. Each value is read back and decrypted under
//              its new name before the old key is removed; a value that fails
//              is REPORTED AND LEFT ALONE, never forced.
//   --verify   after the migration: proves every name in `agent_secret_names`
//              decrypts under its agent-scoped KV name, and that no
//              `sbxenv-env:` key is left behind.
//
// Requires SECRETS_STORE_KEK_RAW_B64 (the same value the Worker holds) and a
// wrangler target:
//
//   --config <wrangler config>   [--d1 <database name>] [--binding SECRETS_KV]
//   --namespace-id <id>          addresses the KV namespace directly
//   --remote                     without it, everything targets LOCAL state
//
// WHAT IT COPIES, AND WHY IT IS NOT JUST A MOVE
// ---------------------------------------------
// Env-var precedence was workspace < environment(workbench) < agent, so the
// legacy agent's secrets ALREADY beat the workbench's for every thread. After
// the merge each workbench is its own agent, and a thread that moves there
// would lose the legacy agent's secrets entirely. So for every agent this
// migration creates, the effective set is reconstructed:
//
//     value(name) = legacyAgentSecret(name) ?? workbenchSecret(name)
//
// which is exactly what a thread on that workbench resolved to before. The
// agent that KEEPS the legacy id already holds its own half; only the
// workbench-only names are added to it.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const IV_BYTES = 12;
export const ENV_PREFIX = "sbxenv-env:";
export const AG_PREFIX = "sbxenv-ag:";

// ---------------------------------------------------------------- crypto
// Duplicated from src/secrets/aead.ts on purpose: this is a Node script and
// cannot import the Worker's TypeScript. The duplication is pinned by
// test/unit/secrets/rekey-workbench-secrets.test.ts, which encrypts with one
// implementation and decrypts with the other in BOTH directions — a drift in
// either turns that test red rather than turning production secrets into
// undecryptable blobs.

export async function importRawKey(raw) {
  if (raw.byteLength !== 32) throw new Error("AES-GCM key must be 32 bytes");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encrypt(key, plaintext, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const additionalData = new TextEncoder().encode(aad);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData },
      key,
      new TextEncoder().encode(plaintext),
    ),
  );
  const payload = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  payload.set(iv, 0);
  payload.set(ciphertext, iv.byteLength);
  return packB64(payload);
}

export async function decrypt(key, packed, aad) {
  const payload = unpackB64(packed);
  if (payload.byteLength <= IV_BYTES) throw new Error("ciphertext too short");
  const iv = payload.slice(0, IV_BYTES);
  const ciphertext = payload.slice(IV_BYTES);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) },
    key,
    ciphertext,
  );
  return new TextDecoder().decode(plaintext);
}

export function packB64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

export function unpackB64(value) {
  return new Uint8Array(Buffer.from(value, "base64"));
}

export const dekAad = (workspaceId) => `${workspaceId}:dek`;
export const secretAad = (workspaceId, name) => `${workspaceId}:${name}`;
export const dekKey = (workspaceId) => `workspaces/${workspaceId}/dek`;
export const secretKey = (workspaceId, name) => `workspaces/${workspaceId}/secrets/${name}`;
export const indexKey = (workspaceId) => `workspaces/${workspaceId}/secret-index`;

// ---------------------------------------------------------------- mapping

/**
 * The workbench -> agent mapping, derived exactly as migration 0067 derives
 * `__wb_agent_map`. The two MUST agree: this script writes KV under the new
 * agent ids and the migration writes D1 under them, and nothing checks them
 * against each other except `--verify`.
 *
 *   - the workspace's EARLIEST agent (created_at, then id) is the legacy agent;
 *   - the workspace's earliest ACTIVE workbench (archived ones sort last, then
 *     created_at, then id) adopts that agent's id;
 *   - every other workbench becomes `agt_<workbenchId>`.
 */
export function deriveAgentIdForWorkbench(agents, workbenches) {
  const byWorkspace = new Map();
  for (const workbench of workbenches) {
    const list = byWorkspace.get(workbench.workspace_id) ?? [];
    list.push(workbench);
    byWorkspace.set(workbench.workspace_id, list);
  }
  const legacyByWorkspace = new Map();
  for (const agent of [...agents].sort(
    (left, right) => left.created_at - right.created_at || compare(left.id, right.id),
  )) {
    if (!legacyByWorkspace.has(agent.workspace_id)) {
      legacyByWorkspace.set(agent.workspace_id, agent.id);
    }
  }

  const mapping = new Map();
  for (const [workspaceId, list] of byWorkspace) {
    const ordered = [...list].sort(
      (left, right) =>
        Number(left.archived_at != null) - Number(right.archived_at != null) ||
        left.created_at - right.created_at ||
        compare(left.id, right.id),
    );
    const legacyAgentId = legacyByWorkspace.get(workspaceId) ?? null;
    for (const [index, workbench] of ordered.entries()) {
      mapping.set(workbench.id, {
        workspaceId,
        agentId: index === 0 && legacyAgentId !== null ? legacyAgentId : `agt_${workbench.id}`,
        isPrimary: index === 0 && legacyAgentId !== null,
        legacyAgentId,
      });
    }
  }
  return mapping;
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Parses `sbxenv-env:<scopeId>:<VAR>`. Returns null for anything else.
 * The variable name may not contain `:` (validateEnvVarName rejects it), so the
 * FIRST colon after the prefix ends the scope id.
 */
export function parseScopedName(prefix, name) {
  if (!name.startsWith(prefix)) return null;
  const rest = name.slice(prefix.length);
  const at = rest.indexOf(":");
  if (at <= 0 || at === rest.length - 1) return null;
  return { scopeId: rest.slice(0, at), varName: rest.slice(at + 1) };
}

// ---------------------------------------------------------------- the re-key

/**
 * Plans and (when `apply`) performs the re-key for ONE workspace.
 *
 * `store` is `{ get(key), put(key, value), delete(key) }` over the raw KV
 * strings — a wrangler-backed one in the CLI, a Map in the tests.
 *
 * Returns a report. Nothing here throws on a single bad secret: a value that
 * will not decrypt is recorded in `failed` and left exactly as it was. A secret
 * that fails to re-encrypt is unrecoverable from the new namespace, so the only
 * safe answer is to report it and let a human look.
 */
export async function rekeyWorkspace({ store, kek, workspaceId, mapping, apply }) {
  const report = {
    workspaceId,
    moved: [],
    copiedFromLegacyAgent: [],
    collisions: [],
    failed: [],
    unmappedWorkbenches: [],
    skipped: null,
  };

  const dekRaw = await store.get(dekKey(workspaceId));
  if (dekRaw === null) {
    report.skipped = "no_dek";
    return report;
  }
  const dek = await importRawKey(
    unpackB64(await decrypt(kek, JSON.parse(dekRaw).wrapped_dek, dekAad(workspaceId))),
  );

  const indexRaw = await store.get(indexKey(workspaceId));
  if (indexRaw === null) {
    // An index is created with the DEK on the first write. A DEK with no index
    // means this workspace predates the index and was never backfilled — the
    // same condition `KVWorkspaceSecretsWriter.readIndex` refuses to treat as an
    // empty store, and for the same reason: guessing here would silently drop
    // every secret it cannot see.
    report.skipped = "index_missing";
    return report;
  }
  const index = JSON.parse(indexRaw);

  const legacyAgentId = [...mapping.values()].find(
    (m) => m.workspaceId === workspaceId,
  )?.legacyAgentId;

  // What the legacy agent already holds. These are the values that WON for every
  // thread, whatever workbench it was on, so they are the base of every agent
  // this migration creates.
  const legacyAgentNames = new Map();
  if (legacyAgentId) {
    for (const name of Object.keys(index.entries)) {
      const parsed = parseScopedName(AG_PREFIX, name);
      if (parsed?.scopeId === legacyAgentId) legacyAgentNames.set(parsed.varName, name);
    }
  }

  // Group this workspace's environment-scoped secrets by workbench.
  const byWorkbench = new Map();
  for (const name of Object.keys(index.entries)) {
    const parsed = parseScopedName(ENV_PREFIX, name);
    if (!parsed) continue;
    const list = byWorkbench.get(parsed.scopeId) ?? [];
    list.push({ ...parsed, oldName: name, updatedAt: index.entries[name].updated_at });
    byWorkbench.set(parsed.scopeId, list);
  }

  const writes = new Map();
  const deletes = new Set();

  for (const [workbenchId, secrets] of byWorkbench) {
    const target = mapping.get(workbenchId);
    if (!target) {
      // The workbench is gone from D1 but its secrets are still in KV. The
      // migration has no row to map either, so these belong to nothing. Report;
      // never guess an owner for a secret.
      report.unmappedWorkbenches.push({ workbenchId, names: secrets.map((s) => s.varName) });
      continue;
    }
    for (const secret of secrets) {
      const newName = `${AG_PREFIX}${target.agentId}:${secret.varName}`;
      if (legacyAgentNames.has(secret.varName)) {
        // The agent layer already carried this name, and the agent layer WON.
        // Overwriting it with the workbench's value would change what the
        // sandbox sees. Left in place, and the old key is left too rather than
        // destroying a value nobody asked to lose.
        report.collisions.push({
          workbenchId,
          agentId: target.agentId,
          name: secret.varName,
          kept: "agent",
        });
        continue;
      }
      let plaintext;
      try {
        plaintext = await decrypt(
          dek,
          JSON.parse(await store.get(secretKey(workspaceId, secret.oldName))).ciphertext,
          secretAad(workspaceId, secret.oldName),
        );
      } catch (error) {
        report.failed.push({
          name: secret.oldName,
          stage: "decrypt",
          error: String(error?.message ?? error),
        });
        continue;
      }
      writes.set(newName, { plaintext, updatedAt: secret.updatedAt });
      deletes.add(secret.oldName);
      report.moved.push({ from: secret.oldName, to: newName });
    }
  }

  // Every agent this migration creates ALSO inherits the legacy agent's own
  // secrets — see the header. The agent that keeps the legacy id already has
  // them under the right key and is skipped.
  for (const target of mapping.values()) {
    if (target.workspaceId !== workspaceId || target.isPrimary) continue;
    for (const [varName, oldName] of legacyAgentNames) {
      const newName = `${AG_PREFIX}${target.agentId}:${varName}`;
      if (writes.has(newName)) continue;
      let plaintext;
      try {
        plaintext = await decrypt(
          dek,
          JSON.parse(await store.get(secretKey(workspaceId, oldName))).ciphertext,
          secretAad(workspaceId, oldName),
        );
      } catch (error) {
        report.failed.push({
          name: oldName,
          stage: "decrypt",
          error: String(error?.message ?? error),
        });
        continue;
      }
      writes.set(newName, { plaintext, updatedAt: index.entries[oldName].updated_at });
      report.copiedFromLegacyAgent.push({ from: oldName, to: newName });
    }
  }

  if (!apply) return report;

  for (const [newName, { plaintext, updatedAt }] of writes) {
    const record = {
      ciphertext: await encrypt(dek, plaintext, secretAad(workspaceId, newName)),
      dek_version: 1,
      updated_at: updatedAt,
    };
    await store.put(secretKey(workspaceId, newName), JSON.stringify(record));
    // Read it back and decrypt it under the NEW name before anything is
    // removed. A write that landed but cannot be read back is the one failure
    // that would otherwise be silent and unrecoverable.
    try {
      const roundTrip = await decrypt(
        dek,
        JSON.parse(await store.get(secretKey(workspaceId, newName))).ciphertext,
        secretAad(workspaceId, newName),
      );
      if (roundTrip !== plaintext) throw new Error("round-trip mismatch");
    } catch (error) {
      report.failed.push({
        name: newName,
        stage: "verify",
        error: String(error?.message ?? error),
      });
      // Keep the source: do NOT delete anything this value came from.
      for (const entry of report.moved) {
        if (entry.to === newName) deletes.delete(entry.from);
      }
      continue;
    }
    index.entries[newName] = { updated_at: updatedAt };
  }

  for (const oldName of deletes) {
    await store.delete(secretKey(workspaceId, oldName));
    delete index.entries[oldName];
  }
  await store.put(indexKey(workspaceId), JSON.stringify(index));
  return report;
}

/**
 * After the migration: every name in `agent_secret_names` must decrypt under
 * `sbxenv-ag:<agentId>:<name>`, and no `sbxenv-env:` key may remain.
 */
export async function verifyWorkspace({ store, kek, workspaceId, secretNameRows }) {
  const report = { workspaceId, verified: [], failed: [], leftover: [] };
  const dekRaw = await store.get(dekKey(workspaceId));
  if (dekRaw === null) return report;
  const dek = await importRawKey(
    unpackB64(await decrypt(kek, JSON.parse(dekRaw).wrapped_dek, dekAad(workspaceId))),
  );
  const indexRaw = await store.get(indexKey(workspaceId));
  const index = indexRaw === null ? { entries: {} } : JSON.parse(indexRaw);

  for (const name of Object.keys(index.entries)) {
    if (name.startsWith(ENV_PREFIX)) report.leftover.push(name);
  }
  for (const row of secretNameRows) {
    const name = `${AG_PREFIX}${row.agent_id}:${row.name}`;
    try {
      const raw = await store.get(secretKey(workspaceId, name));
      if (raw === null) throw new Error("missing in KV");
      await decrypt(dek, JSON.parse(raw).ciphertext, secretAad(workspaceId, name));
      report.verified.push(name);
    } catch (error) {
      report.failed.push({ name, error: String(error?.message ?? error) });
    }
  }
  return report;
}

/**
 * The skill-name collisions migration 0067 will leave agent-private. Reported
 * here rather than by the migration because SQL cannot log: the migration
 * promotes ONE owner's copy per (workspace, name) — the oldest by created_at,
 * tie-broken by id — and a silently-dropped skill body would be unrecoverable.
 */
export function skillCollisions(skills) {
  const groups = new Map();
  for (const skill of skills) {
    if (skill.agent_id === null || skill.archived_at !== null) continue;
    const key = `${skill.workspace_id} ${skill.name}`;
    const list = groups.get(key) ?? [];
    list.push(skill);
    groups.set(key, list);
  }
  const out = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const ordered = [...list].sort(
      (left, right) => left.created_at - right.created_at || compare(left.id, right.id),
    );
    out.push({
      workspaceId: ordered[0].workspace_id,
      name: ordered[0].name,
      promoted: ordered[0].id,
      leftAgentPrivate: ordered.slice(1).map((s) => ({ id: s.id, agentId: s.agent_id })),
    });
  }
  return out;
}

// ---------------------------------------------------------------- CLI

function wranglerStore({ target, remote }) {
  return {
    async get(key) {
      try {
        const raw = execFileSync(
          "pnpm",
          ["exec", "wrangler", "kv", "key", "get", key, ...target, ...remote],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        );
        return raw.length === 0 ? null : raw;
      } catch (error) {
        const stderr = String(error?.stderr ?? error);
        if (stderr.includes("404") || stderr.includes("Not Found")) return null;
        throw new Error(`read ${key}: ${stderr}`);
      }
    },
    async put(key, value) {
      const dir = mkdtempSync(join(tmpdir(), "nadi-rekey-"));
      const file = join(dir, "value.json");
      try {
        writeFileSync(file, value, { mode: 0o600 });
        execFileSync(
          "pnpm",
          ["exec", "wrangler", "kv", "key", "put", key, "--path", file, ...target, ...remote],
          { stdio: "ignore" },
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    async delete(key) {
      execFileSync("pnpm", ["exec", "wrangler", "kv", "key", "delete", key, ...target, ...remote], {
        stdio: "ignore",
      });
    },
  };
}

function d1Query({ database, configPath, remote }, sql) {
  const raw = execFileSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      database,
      ...(configPath ? ["--config", configPath] : []),
      ...remote,
      "--json",
      "--command",
      sql,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const parsed = JSON.parse(raw.slice(raw.indexOf("[")));
  return parsed[0]?.results ?? [];
}

async function main(argv) {
  const flag = (name) => {
    const at = argv.indexOf(name);
    return at === -1 ? null : (argv[at + 1] ?? null);
  };
  const mode = argv.includes("--apply")
    ? "apply"
    : argv.includes("--verify")
      ? "verify"
      : argv.includes("--plan")
        ? "plan"
        : null;
  if (mode === null) {
    console.error("error: pass one of --plan, --apply, --verify");
    return 2;
  }
  const remote = argv.includes("--remote") ? ["--remote"] : [];
  const namespaceId = flag("--namespace-id");
  const configPath = flag("--config");
  const binding = flag("--binding") ?? "SECRETS_KV";
  const database = flag("--d1") ?? "nadi-registry";
  // The placeholder in this repo's own wrangler.jsonc. Addressing it is never
  // what anyone meant, and the failure would come back as a confusing 404.
  if (namespaceId === "0".repeat(32)) {
    console.error("error: that is the placeholder namespace id from wrangler.jsonc");
    return 2;
  }
  if (remote.length > 0 && namespaceId === null && configPath === null) {
    console.error("error: --remote needs --namespace-id <id>, or --config <wrangler config>");
    return 2;
  }
  const kekRaw = process.env.SECRETS_STORE_KEK_RAW_B64;
  if (!kekRaw) {
    console.error("error: SECRETS_STORE_KEK_RAW_B64 is required");
    return 2;
  }
  const kek = await importRawKey(unpackB64(kekRaw));
  const target = namespaceId !== null ? ["--namespace-id", namespaceId] : ["--binding", binding];
  if (configPath !== null && namespaceId === null) target.push("--config", configPath);
  const store = wranglerStore({ target, remote });
  const d1 = { database, configPath, remote };

  if (mode === "verify") {
    const rows = d1Query(d1, "SELECT agent_id, name FROM agent_secret_names");
    const agents = d1Query(d1, "SELECT id, workspace_id FROM agents");
    const workspaceOf = new Map(agents.map((a) => [a.id, a.workspace_id]));
    const byWorkspace = new Map();
    for (const row of rows) {
      const workspaceId = workspaceOf.get(row.agent_id);
      if (!workspaceId) continue;
      const list = byWorkspace.get(workspaceId) ?? [];
      list.push(row);
      byWorkspace.set(workspaceId, list);
    }
    let failures = 0;
    for (const [workspaceId, secretNameRows] of byWorkspace) {
      const report = await verifyWorkspace({ store, kek, workspaceId, secretNameRows });
      failures += report.failed.length + report.leftover.length;
      console.log(JSON.stringify(report, null, 2));
    }
    console.log(failures === 0 ? "VERIFY OK" : `VERIFY FAILED (${failures})`);
    return failures === 0 ? 0 : 1;
  }

  const agents = d1Query(d1, "SELECT id, workspace_id, created_at FROM agents");
  const workbenches = d1Query(
    d1,
    "SELECT id, workspace_id, created_at, archived_at FROM workbenches",
  );
  const mapping = deriveAgentIdForWorkbench(agents, workbenches);
  console.log("== workbench -> agent mapping");
  for (const [workbenchId, target] of mapping) {
    console.log(`  ${workbenchId} -> ${target.agentId}${target.isPrimary ? "  (adopts)" : ""}`);
  }

  const collisions = skillCollisions(
    d1Query(d1, "SELECT id, workspace_id, agent_id, name, created_at, archived_at FROM skills"),
  );
  console.log("== skill-name collisions (left agent-private by the migration)");
  console.log(collisions.length === 0 ? "  none" : JSON.stringify(collisions, null, 2));

  const workspaceIds = [...new Set(agents.map((a) => a.workspace_id))];
  let failures = 0;
  for (const workspaceId of workspaceIds) {
    const report = await rekeyWorkspace({
      store,
      kek,
      workspaceId,
      mapping,
      apply: mode === "apply",
    });
    failures += report.failed.length + report.unmappedWorkbenches.length;
    console.log(JSON.stringify(report, null, 2));
  }
  console.log(
    `${mode === "apply" ? "APPLIED" : "PLANNED"}${failures === 0 ? "" : ` WITH ${failures} PROBLEM(S)`}`,
  );
  return failures === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv.slice(2)));
}
