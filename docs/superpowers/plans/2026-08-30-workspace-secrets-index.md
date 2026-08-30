# Workspace Secrets Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop listing KV by prefix to enumerate workspace secrets. Maintain one index key per workspace on write, read it on list, and leave `src/` with no `kv.list()` call on the secrets path at all.

**Architecture:** Every workspace gets `workspaces/<id>/secret-index`, holding `{ name -> { updated_at } }`. `KVWorkspaceSecretsWriter` seeds it when it creates the workspace DEK and maintains it inside `set()` and `delete()` — the only mutation paths, so every caller is covered without being touched. `listMetadata()` reads it and never lists. The two existing deployments are migrated once by a script that runs outside the app.

**Tech Stack:** TypeScript, Cloudflare Workers KV / celld native KV, Vitest (`unit` project). No schema change, no Drizzle migration.

**Spec:** This document. The root cause is recorded under "Background" below.

---

## Background: the measured root cause

`GET /api/settings/sandbox` returns 500 on celld v0.4.0:

```
SecretsError: SQL error: step SQL cursor: LIKE or GLOB pattern too complex
  at KVWorkspaceSecretsWriter.fail (worker.js:93074:15)
  <- at KVWorkspaceSecretsWriter.listMetadata (worker.js:93026:23)
  <- at async ComputeEnvSecretsStore.listByPrefix (worker.js:109850:22)
```

celld compiles `list({ prefix })` into a SQL `LIKE` pattern, escaping each `_`
and `%` into two characters, then hits SQLite's
`SQLITE_LIMIT_LIKE_PATTERN_LENGTH` — 49 bytes on celld's Durable Object SQLite.
Measured on a live v0.4.0 node with `celld kv list --prefix`:

| Prefix | Effective bytes | Result |
| --- | --- | --- |
| 49 x `a` | 49 | ok |
| 50 x `a` | 50 | FAIL |
| 48 x `a` + `_` | 50 | FAIL |
| 48 x `a` + `%` | 50 | FAIL |

The budget is `utf8_len(prefix) + count(_ % \) <= 49`. Nadi's prefix is
`workspaces/${workspaceId}/secrets/` — 59 characters plus the `_` in `ws_`, so
**60**. Workspace ids are a fixed-length `ws_` + UUID, so this is not
data-dependent: every workspace-secrets listing on celld fails, and has since
the KV move in #63. Reproduced in celld's own CLI with Nadi out of the picture,
so the defect is celld's; this is Nadi's workaround.

Cloudflare KV has no such limit, which is why CI never saw it.

Two further defects, both removed as a consequence rather than as separate work:

1. `listMetadata` reads only `page.keys` and never follows `cursor`, so past
   1,000 keys it silently truncates.
2. It then issues one `get()` per key to read `updated_at` — a central list plus
   N reads to render one settings page. Cloudflare's docs recommend against
   exactly this shape, and `list` is not on the edge-cached fast path that
   `get` is.

## Why there is no runtime rebuild

An earlier draft had `listMetadata` rebuild the index by listing whenever the
index was absent, so an operator could never forget a migration step. That was
justified by unknown self-hosters. **There are none** — Cloudflare production and
`chengal-517c.exe.xyz` are the only two deployments, both operated by the repo
owner, so the migration is two deliberate script runs rather than a step someone
might miss.

Dropping the fallback is what lets `safeListPrefix`, a `kvListPrefixMaxBytes`
platform capability, and `rebuildIndex` all not exist. The result is that `src/`
never calls `kv.list()` for secrets: the hazard is removed rather than guarded.

**If Nadi ever gains outside self-hosters, revisit this.** A missing index then
becomes a live failure mode with no automatic repair, and either the lazy
rebuild comes back or the upgrade notes must carry the backfill step.

## Global Constraints

- **Do not change any `/api/*` response shape.** `/api/settings/sandbox` returns
  the same JSON before and after, so `web/src/mocks/` needs no change and should
  get none.
- **No database migration.** Nothing in `migrations/` or `src/db/schema.ts`.
- **The index is plaintext, deliberately.** It holds secret *names* and
  timestamps — exactly what `listMetadata` already returns in the clear to the
  settings UI, and what the KV key names already expose. Values stay AES-GCM
  under the workspace DEK, untouched. This is also what lets the backfill script
  run without the KEK.
- **A missing index must never read as an empty one.** An empty secrets store
  looks exactly like a workspace with no secrets configured — the failure
  `src/secrets/index.ts` already argues against for `secretsBinding`. Missing is
  loud; empty is a real answer.
- **Run `pnpm test`**, not `test:unit`/`test:integration` — only the bare command
  runs all six Vitest projects.
- Verify with `pnpm run typecheck` and `pnpm run check` before each commit.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/secrets/errors.ts` | add the `index_missing` error code |
| `src/secrets/kv-records.ts` | index key builder, record type, parser |
| `src/secrets/kv-writer.ts` | seed, maintain and read the index; no `list` |
| `scripts/backfill-secret-index.mjs` | one-off backfill, Cloudflare (wrangler) |
| `deploy/celld/backfill-secret-index.sh` | one-off backfill, celld (celld kv) |
| `test/unit/secrets/workspace-secrets.test.ts` | index behaviour + loud-failure guards |
| `docs/self-hosting-celld.md` | record the celld limit and the decision |
| `AGENTS.md` | the invariant, for the next reader |

---

### Task 1: The index record

**Files:**
- Modify: `src/secrets/errors.ts:1`, `src/secrets/kv-records.ts`, `src/secrets/index.ts`
- Test: `test/unit/secrets/workspace-secrets.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `buildWorkspaceSecretIndexKey(workspaceId: string): string`;
  `StoredWorkspaceSecretIndex`;
  `parseWorkspaceSecretIndex(raw: string, workspaceId: string): StoredWorkspaceSecretIndex`;
  the `"index_missing"` member of `SecretsErrorCode`.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/secrets/workspace-secrets.test.ts`:

```ts
describe("workspace secret index records", () => {
  it("builds an index key that is not itself under the secrets prefix", () => {
    const key = buildWorkspaceSecretIndexKey("ws_1");
    expect(key).toBe("workspaces/ws_1/secret-index");
    expect(key.startsWith(buildWorkspaceSecretPrefix("ws_1"))).toBe(false);
  });

  it("parses a well-formed index", () => {
    const raw = JSON.stringify({
      version: 1,
      entries: { EXA_API_KEY: { updated_at: "2026-08-30T00:00:00.000Z" } },
    });
    expect(parseWorkspaceSecretIndex(raw, "ws_1")).toEqual({
      version: 1,
      entries: { EXA_API_KEY: { updated_at: "2026-08-30T00:00:00.000Z" } },
    });
  });

  it("rejects a malformed index rather than reading it as empty", () => {
    expect(() => parseWorkspaceSecretIndex("{]", "ws_1")).toThrow(/invalid workspace secret index/);
    expect(() => parseWorkspaceSecretIndex('{"version":2,"entries":{}}', "ws_1")).toThrow(
      /invalid workspace secret index/,
    );
    expect(() => parseWorkspaceSecretIndex('{"version":1}', "ws_1")).toThrow(
      /invalid workspace secret index/,
    );
    expect(() => parseWorkspaceSecretIndex('{"version":1,"entries":{"A":{}}}', "ws_1")).toThrow(
      /invalid workspace secret index/,
    );
  });
});
```

Add `buildWorkspaceSecretIndexKey`, `buildWorkspaceSecretPrefix` and
`parseWorkspaceSecretIndex` to the file's existing import from
`../../../src/secrets`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/secrets/workspace-secrets.test.ts`
Expected: FAIL — `buildWorkspaceSecretIndexKey is not a function`

- [ ] **Step 3: Add the error code**

`src/secrets/errors.ts` line 1 becomes:

```ts
export type SecretsErrorCode =
  | "kek_unavailable"
  | "dek_corrupt"
  | "secret_corrupt"
  | "store_error"
  | "index_missing";
```

Nothing switches exhaustively on this type, so adding a member is safe.

- [ ] **Step 4: Add the record**

In `src/secrets/kv-records.ts`, after `buildWorkspaceSecretPrefix`:

```ts
/**
 * One key per workspace listing the secret names it holds, so listing never
 * needs `kv.list({ prefix })`. Named `secret-index` rather than
 * `secrets/index` deliberately: it must NOT sit under
 * `buildWorkspaceSecretPrefix`, or a backfill would ingest the index as if it
 * were a secret.
 */
export function buildWorkspaceSecretIndexKey(workspaceId: string): string {
  return `workspaces/${workspaceId}/secret-index`;
}

export interface StoredWorkspaceSecretIndex {
  version: 1;
  entries: Record<string, { updated_at: string }>;
}

export function parseWorkspaceSecretIndex(
  raw: string,
  workspaceId: string,
): StoredWorkspaceSecretIndex {
  const message = `invalid workspace secret index for ${workspaceId}`;
  const parsed = parseJson(raw, message);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { version?: unknown }).version !== 1 ||
    typeof (parsed as { entries?: unknown }).entries !== "object" ||
    (parsed as { entries?: unknown }).entries === null
  ) {
    throw new Error(message);
  }
  const entries = (parsed as { entries: Record<string, unknown> }).entries;
  for (const value of Object.values(entries)) {
    if (
      typeof value !== "object" ||
      value === null ||
      typeof (value as { updated_at?: unknown }).updated_at !== "string"
    ) {
      throw new Error(message);
    }
  }
  return parsed as StoredWorkspaceSecretIndex;
}
```

In `src/secrets/index.ts`, add `buildWorkspaceSecretIndexKey` and
`parseWorkspaceSecretIndex` to the existing `export { ... } from "./kv-records";`
block, and add
`export type { StoredWorkspaceSecretIndex } from "./kv-records";`

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run test/unit/secrets/workspace-secrets.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/secrets/errors.ts src/secrets/kv-records.ts src/secrets/index.ts test/unit/secrets/workspace-secrets.test.ts
git commit -m "feat(secrets): add the per-workspace secret index record"
```

---

### Task 2: Seed, maintain and read the index

This is the task that fixes the bug and deletes the `list` call.

**Files:**
- Modify: `src/secrets/kv-writer.ts:21-98`
- Test: `test/unit/secrets/workspace-secrets.test.ts`

**Interfaces:**
- Consumes: Task 1's record helpers and the `index_missing` code.
- Produces: no signature changes. `ensureWorkspaceDek`, `set`, `delete` and
  `listMetadata` keep their exact existing signatures and return types.

- [ ] **Step 1: Make the test double enforce celld's limit**

The existing `MemoryKV` mock accepts any prefix, which is exactly why the unit
suite never caught a bug that broke every celld deployment. Replace its `list`
method so the old implementation could not pass:

```ts
  // Mirrors celld: a list prefix over 49 bytes (each `_`/`%`/`\` counting two,
  // because celld escapes it into a LIKE pattern) is rejected by SQLite. A mock
  // that accepts any prefix is why this shipped broken. Nothing in src/ should
  // call this at all once the index lands.
  async list(input?: { prefix?: string }): Promise<KVNamespaceListResult<unknown>> {
    const prefix = input?.prefix ?? "";
    let cost = 0;
    for (const char of prefix) {
      cost += char === "_" || char === "%" || char === "\\" ? 2 : 1;
    }
    if (cost > 49) {
      throw new Error("SQL error: step SQL cursor: LIKE or GLOB pattern too complex");
    }
    return {
      keys: [...this.values.keys()].filter((n) => n.startsWith(prefix)).sort().map((name) => ({ name })),
      list_complete: true,
      cacheStatus: null,
    };
  }
```

- [ ] **Step 2: Write the failing tests**

```ts
describe("workspace secret listing without a KV prefix scan", () => {
  const ws = "ws_cf8e3c5c-8a9a-4904-a32b-d68e8e5f28d0";

  function writerFor(kv: MemoryKV) {
    return new KVWorkspaceSecretsWriter(
      kv as unknown as KVNamespace,
      importRawKey(new Uint8Array(32).fill(3)),
    );
  }

  it("lists secrets for a real-length workspace id", async () => {
    const kv = new MemoryKV();
    const writer = writerFor(kv);

    await writer.ensureWorkspaceDek(ws);
    await writer.set(ws, "EXA_API_KEY", "v1", { updatedAt: "2026-08-30T01:00:00.000Z" });
    await writer.set(ws, "provider:opencode-go", "v2", { updatedAt: "2026-08-30T02:00:00.000Z" });

    await expect(writer.listMetadata(ws)).resolves.toEqual([
      { name: "EXA_API_KEY", updated_at: "2026-08-30T01:00:00.000Z" },
      { name: "provider:opencode-go", updated_at: "2026-08-30T02:00:00.000Z" },
    ]);
  });

  it("never calls list", async () => {
    const kv = new MemoryKV();
    const writer = writerFor(kv);
    const listed: string[] = [];
    const original = kv.list.bind(kv);
    kv.list = async (input?: { prefix?: string }) => {
      listed.push(input?.prefix ?? "");
      return original(input);
    };

    await writer.ensureWorkspaceDek(ws);
    await writer.set(ws, "A", "v", { updatedAt: "2026-08-30T01:00:00.000Z" });
    await writer.listMetadata(ws);
    await writer.delete(ws, "A");
    await writer.listMetadata(ws);

    expect(listed).toEqual([]);
  });

  it("returns an empty list for a workspace that has never held a secret", async () => {
    const kv = new MemoryKV();
    await expect(writerFor(kv).listMetadata(ws)).resolves.toEqual([]);
  });

  it("fails loudly when a workspace has a DEK but no index", async () => {
    const kv = new MemoryKV();
    const writer = writerFor(kv);

    await writer.ensureWorkspaceDek(ws);
    await writer.set(ws, "LEGACY", "v", { updatedAt: "2026-08-30T03:00:00.000Z" });
    // The pre-index world: DEK and values exist, no index does.
    kv.values.delete(buildWorkspaceSecretIndexKey(ws));

    await expect(writer.listMetadata(ws)).rejects.toMatchObject({
      name: "SecretsError",
      code: "index_missing",
    });
  });

  it("refuses to write rather than erase an un-backfilled workspace", async () => {
    const kv = new MemoryKV();
    const writer = writerFor(kv);

    await writer.ensureWorkspaceDek(ws);
    await writer.set(ws, "OLD", "v", { updatedAt: "2026-08-30T01:00:00.000Z" });
    kv.values.delete(buildWorkspaceSecretIndexKey(ws));

    await expect(writer.set(ws, "NEW", "v")).rejects.toMatchObject({ code: "index_missing" });
    // And the pre-existing secret is untouched.
    expect(kv.values.has(buildWorkspaceSecretKey(ws, "OLD"))).toBe(true);
  });

  it("drops a deleted secret from the listing", async () => {
    const kv = new MemoryKV();
    const writer = writerFor(kv);

    await writer.ensureWorkspaceDek(ws);
    await writer.set(ws, "A", "v", { updatedAt: "2026-08-30T01:00:00.000Z" });
    await writer.set(ws, "B", "v", { updatedAt: "2026-08-30T02:00:00.000Z" });
    await expect(writer.delete(ws, "A")).resolves.toBe(true);

    await expect(writer.listMetadata(ws)).resolves.toEqual([
      { name: "B", updated_at: "2026-08-30T02:00:00.000Z" },
    ]);
  });

  it("lets a ghost index entry be deleted even though its value is gone", async () => {
    const kv = new MemoryKV();
    const writer = writerFor(kv);

    await writer.ensureWorkspaceDek(ws);
    await writer.set(ws, "GHOST", "v", { updatedAt: "2026-08-30T04:00:00.000Z" });
    // A delete that crashed between removing the value and updating the index.
    kv.values.delete(buildWorkspaceSecretKey(ws, "GHOST"));

    // `false` reports that no value was destroyed; the index is repaired anyway,
    // so the ghost is not permanent.
    await expect(writer.delete(ws, "GHOST")).resolves.toBe(false);
    await expect(writer.listMetadata(ws)).resolves.toEqual([]);
  });
});
```

Extend the import from `../../../src/secrets` with `buildWorkspaceSecretIndexKey`.

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/secrets/workspace-secrets.test.ts`
Expected: FAIL. "lists secrets for a real-length workspace id" fails with
"LIKE or GLOB pattern too complex" — the mock now reproduces production.

- [ ] **Step 4: Implement**

Extend the imports in `src/secrets/kv-writer.ts`:

```ts
import {
  buildWorkspaceDekKey,
  buildWorkspaceSecretIndexKey,
  buildWorkspaceSecretKey,
  parseWorkspaceDekRecord,
  parseWorkspaceSecretIndex,
  parseWorkspaceSecretRecord,
  type StoredWorkspaceDek,
  type StoredWorkspaceSecret,
  type StoredWorkspaceSecretIndex,
} from "./kv-records";
```

`buildWorkspaceSecretPrefix` and `parseSecretNameFromKey` become unused here —
remove them from the import. Leave them exported from `kv-records.ts`; the
backfill scripts mirror the same layout and the tests still assert on them.

Seed the index when the DEK is created, so a workspace is born indexed:

```ts
  async ensureWorkspaceDek(workspaceId: string): Promise<boolean> {
    const key = buildWorkspaceDekKey(workspaceId);
    const existing = await this.getText(key);
    if (existing !== null) {
      await this.unwrapWorkspaceDek(existing, workspaceId);
      return false;
    }

    const rawDek = crypto.getRandomValues(new Uint8Array(32));
    const record: StoredWorkspaceDek = {
      wrapped_dek: await encrypt(await this.kek, packB64(rawDek), dekAad(workspaceId)),
      kek_version: 1,
      created_at: new Date().toISOString(),
    };
    await this.putText(key, JSON.stringify(record));
    // Seed an empty index alongside the DEK. Every write path calls this first,
    // so from here on "index missing" can only mean "predates the index" —
    // which is what lets listMetadata tell that apart from "no secrets".
    await this.putText(
      buildWorkspaceSecretIndexKey(workspaceId),
      JSON.stringify({ version: 1, entries: {} } satisfies StoredWorkspaceSecretIndex),
    );
    return true;
  }
```

`set()` — value first, index second:

```ts
    await this.putText(buildWorkspaceSecretKey(workspaceId, name), JSON.stringify(record));
    await this.writeIndex(workspaceId, (index) => {
      index.entries[name] = { updated_at: record.updated_at };
    });
```

The value is the durable fact and the index is the pointer to it, so the value
lands first. A crash between the two leaves a secret readable by name but absent
from the listing until the next `set` — the failure mode that loses nothing.

`delete()` — value first, then repair the index unconditionally:

```ts
  async delete(workspaceId: string, name: string): Promise<boolean> {
    const key = buildWorkspaceSecretKey(workspaceId, name);
    const existed = (await this.getText(key)) !== null;
    if (existed) {
      try {
        await this.kv.delete(key);
      } catch (error) {
        return this.fail("store_error", error);
      }
    }
    // Drop the index entry EVEN IF the value was already gone. A delete that
    // crashed between the two writes leaves a name in the listing pointing at
    // nothing; without this the UI's delete button reports "not found" and walks
    // away, making the ghost permanent.
    await this.writeIndex(workspaceId, (index) => {
      delete index.entries[name];
    });
    return existed;
  }
```

`listMetadata()` — one `get`, no list:

```ts
  async listMetadata(workspaceId: string): Promise<Array<{ name: string; updated_at: string }>> {
    const index = await this.readIndex(workspaceId);
    if (index === null) return [];

    return Object.entries(index.entries)
      .map(([name, entry]) => ({ name, updated_at: entry.updated_at }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }
```

And the two private helpers:

```ts
  /**
   * The index, or `null` for a workspace that has never held a secret.
   *
   * A workspace gets its DEK and its index together on the first write, so a
   * DEK with no index means the workspace predates the index and has NOT been
   * backfilled. That must not read as an empty list: an empty secrets store
   * looks exactly like a workspace with nothing configured, and a user who
   * believes that will re-add secrets that are already there.
   */
  private async readIndex(workspaceId: string): Promise<StoredWorkspaceSecretIndex | null> {
    const raw = await this.getText(buildWorkspaceSecretIndexKey(workspaceId));
    if (raw !== null) {
      try {
        return parseWorkspaceSecretIndex(raw, workspaceId);
      } catch (error) {
        return this.fail("store_error", error);
      }
    }
    if ((await this.getText(buildWorkspaceDekKey(workspaceId))) === null) return null;
    throw new SecretsError(
      "index_missing",
      `workspace ${workspaceId} has secrets but no secret index — run the backfill ` +
        `(scripts/backfill-secret-index.mjs, or deploy/celld/backfill-secret-index.sh)`,
    );
  }

  /**
   * Read-modify-write of the index.
   *
   * KV has no compare-and-swap, so two secrets written concurrently can race and
   * lose one INDEX entry — never a value. Contention here is a human in a
   * settings form, and re-running the backfill is the repair. Do not move a
   * high-frequency writer onto this path without revisiting that.
   */
  private async writeIndex(
    workspaceId: string,
    mutate: (index: StoredWorkspaceSecretIndex) => void,
  ): Promise<void> {
    const index = (await this.readIndex(workspaceId)) ?? { version: 1, entries: {} };
    mutate(index);
    await this.putText(buildWorkspaceSecretIndexKey(workspaceId), JSON.stringify(index));
  }
```

`readIndex` throwing is what makes the "refuses to write rather than erase" test
pass: an un-backfilled workspace fails the write loudly instead of quietly
replacing its index with a one-entry one.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/secrets/workspace-secrets.test.ts`
Expected: PASS, pre-existing tests included.

- [ ] **Step 6: Confirm the list call is gone from the secrets path**

Run: `rg -n '\.list\(' src/secrets/ src/compute/env-secrets.ts`
Expected: no matches. Then `rg -n '\.list\(' src/` and confirm every remaining
hit is on a prefix that cannot exceed 49 bytes; note any that can — fixing them
is not this change, but an unrecorded one is the next incident.

- [ ] **Step 7: Full gates**

Run: `pnpm test && pnpm run typecheck && pnpm run check`
Expected: all six Vitest projects green.

- [ ] **Step 8: Commit**

```bash
git add src/secrets/kv-writer.ts test/unit/secrets/workspace-secrets.test.ts
git commit -m "fix(secrets): list workspace secrets from an index, not a KV prefix scan"
```

---

### Task 3: The one-off backfill scripts

Two deployments, two CLIs, one output. Both scripts build the same JSON and are
idempotent — re-running over a healthy index rewrites the same bytes.

Neither needs the KEK: `updated_at` sits in the record's plaintext beside the
ciphertext, so the backfill reads metadata without ever decrypting a secret.

**Files:**
- Create: `scripts/backfill-secret-index.mjs` (Cloudflare)
- Create: `deploy/celld/backfill-secret-index.sh` (celld)

**Interfaces:**
- Consumes: the key layout from Task 1 — `workspaces/<id>/secrets/<name>` and
  `workspaces/<id>/secret-index`.
- Produces: nothing importable; these are operator tools.

- [ ] **Step 1: Write the celld script**

`deploy/celld/backfill-secret-index.sh`, run on the host from `deploy/celld`:

```bash
#!/usr/bin/env bash
# Build workspaces/<id>/secret-index from the secret keys already in KV.
#
# One-off: Nadi maintains the index on every write from the release that
# introduced it. Run this once per deployment, right after deploying that
# release and BEFORE serving traffic — until it runs, every settings page 500s
# with `index_missing` and every secret write is refused. That is deliberate:
# the alternative was a listing that silently showed no secrets.
#
# Idempotent. Re-running over a healthy index rewrites identical bytes.
#
# `celld kv list` is capped at a 49-byte prefix, so this lists on `workspaces/`
# (11 bytes) and filters here.
set -euo pipefail
cd "$(dirname "$0")"

kv() {
  docker compose run --rm --entrypoint celld migrate kv "$@" \
    --bucket s3://celld-fleet --endpoint http://minio:9000 2>/dev/null \
    | grep -v "INFO object_store"
}

keys=$(kv list nadi-secrets --prefix "workspaces/" --all | grep '/secrets/' || true)
if [ -z "$keys" ]; then
  echo "no secret keys found — nothing to backfill"
  exit 0
fi

workspaces=$(printf '%s\n' "$keys" | sed -E 's#^workspaces/([^/]+)/secrets/.*#\1#' | sort -u)
for ws in $workspaces; do
  entries=""
  while IFS= read -r key; do
    name=${key#workspaces/$ws/secrets/}
    updated=$(kv get nadi-secrets "$key" | python3 -c 'import json,sys; print(json.load(sys.stdin)["updated_at"])')
    entries="$entries$(printf '%s\t%s\n' "$name" "$updated")"$'\n'
  done < <(printf '%s\n' "$keys" | grep "^workspaces/$ws/secrets/")

  index=$(printf '%s' "$entries" | python3 -c '
import json,sys
entries = {}
for line in sys.stdin:
    line = line.rstrip("\n")
    if not line: continue
    name, updated = line.split("\t", 1)
    entries[name] = {"updated_at": updated}
print(json.dumps({"version": 1, "entries": entries}))')

  kv put nadi-secrets "workspaces/$ws/secret-index" "$index" >/dev/null
  echo "$ws: $(printf '%s' "$index" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["entries"]))') secrets indexed"
done
echo "backfill complete"
```

`chmod +x deploy/celld/backfill-secret-index.sh`.

- [ ] **Step 2: Write the Cloudflare script**

`scripts/backfill-secret-index.mjs`:

```js
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
```

Check `pnpm exec wrangler kv key --help` before running: wrangler's `kv`
subcommand names have changed across major versions (`kv:key list` in v2,
`kv key list` in v3+). Match the version in this repo's `package.json` rather
than trusting the snippet.

- [ ] **Step 3: Dry-run the celld script against the live box**

The safest rehearsal available: chengal currently holds one workspace with two
secrets, and the index does not exist yet.

```bash
ssh -o IdentityAgent=none -i ~/.ssh/id_ed25519 chengal-517c.exe.xyz \
  'cd ~/nadi/deploy/celld && docker compose run --rm --entrypoint celld migrate \
   kv list nadi-secrets --all --bucket s3://celld-fleet --endpoint http://minio:9000'
```

Expected, before any backfill: four keys — the cron marker, the workspace DEK,
and two under `/secrets/`, with no `secret-index`.

- [ ] **Step 4: Commit**

```bash
git add scripts/backfill-secret-index.mjs deploy/celld/backfill-secret-index.sh
git commit -m "feat(secrets): add one-off secret-index backfill scripts"
```

---

### Task 4: Record the limit and the decision, then roll out

**Files:**
- Modify: `docs/self-hosting-celld.md`, `AGENTS.md`

- [ ] **Step 1: Add the constraint to the celld doc**

Under "Two celld runtime constraints the code works around", add a third and
retitle the heading to "Three celld runtime constraints the code works around":

```markdown
**A KV list prefix cannot exceed 49 bytes.** celld compiles `list({ prefix })`
into a SQL `LIKE` pattern and SQLite rejects one longer than
`SQLITE_LIMIT_LIKE_PATTERN_LENGTH` — 49 bytes — with `LIKE or GLOB pattern too
complex`. Each `_`, `%` or `\` costs two, because celld escapes it. Measured on
a live v0.4.0 node: a 49-byte plain prefix lists, a 50-byte one fails, and one
`_` moves the boundary down by exactly one.

Nadi's workspace-secrets prefix was 60 bytes under that accounting, so every
`/api/settings/sandbox` load returned 500 on celld until the secret index
landed. Cloudflare KV has no equivalent limit, which is why nothing in CI saw
it.

The fix removed the listing rather than shortening the prefix: workspace
secrets are enumerated from `workspaces/<id>/secret-index`, maintained on every
write, and `src/` no longer calls `kv.list()` on the secrets path at all. A
workspace that predates the index fails loudly with `index_missing` until
`deploy/celld/backfill-secret-index.sh` has run — deliberately, because a
silent empty listing is indistinguishable from a workspace with no secrets.
```

- [ ] **Step 2: Add the invariant to AGENTS.md**

```markdown
- **Do not enumerate KV with a long list prefix.** celld compiles
  `list({ prefix })` into a SQL LIKE pattern, each `_`/`%`/`\` costing two, and
  SQLite rejects anything past 49 bytes with "LIKE or GLOB pattern too
  complex". Cloudflare has no such limit, so a long prefix passes CI and breaks
  only the self-hosted deployment. Prefer an index key — one edge-cached `get`
  instead of a central list plus N reads on BOTH platforms — as
  `workspaces/<id>/secret-index` does. If you must list, keep the prefix inside
  the budget and re-filter in memory.
- **A missing index is not an empty one.** Workspace secrets fail loudly with
  `index_missing` rather than returning `[]`, because an empty secrets store
  looks exactly like a workspace with nothing configured. New self-hosters
  would need the backfill wired back into the read path — see "Why there is no
  runtime rebuild" in `docs/superpowers/plans/2026-08-30-workspace-secrets-index.md`.
```

- [ ] **Step 3: Commit**

```bash
git add docs/self-hosting-celld.md AGENTS.md
git commit -m "docs(celld): record the 49-byte KV list-prefix limit"
```

- [ ] **Step 4: Roll out to celld (chengal)**

Deploy, then backfill, then check — in that order, because writes are refused
in between:

```bash
ssh -o IdentityAgent=none -i ~/.ssh/id_ed25519 chengal-517c.exe.xyz \
  '~/update-nadi.sh --ref origin/<branch>'
ssh -o IdentityAgent=none -i ~/.ssh/id_ed25519 chengal-517c.exe.xyz \
  '~/nadi/deploy/celld/backfill-secret-index.sh'
```

Expect a NEW Version ID from the deploy — an unchanged one means nothing
rebuilt and the node adopted the old code — then
`ws_cf8e3c5c-…: 2 secrets indexed`.

- [ ] **Step 5: Verify celld end to end**

```bash
curl -s -b <cookie-jar> -w ' [%{http_code}]' https://nadi-beta.ruqqq.sg/api/settings/sandbox
```

Expected: `200`, listing `EXA_API_KEY` and `provider:opencode-go`. Before this
change it is a 500 carrying `LIKE or GLOB pattern too complex`.

Then re-list the namespace and confirm a fifth key,
`workspaces/ws_cf8e3c5c-…/secret-index`. Finally add a secret in Settings,
reload, confirm it appears, delete it, reload, confirm it is gone — that is what
proves `set`/`delete` maintain the index rather than the backfill having masked
a broken write path.

- [ ] **Step 6: Roll out to Cloudflare**

Same order — deploy, backfill, verify:

```bash
pnpm run deploy
node scripts/backfill-secret-index.mjs --binding SECRETS_KV --remote
```

Then load Settings -> Sandbox for a workspace that already had secrets and
confirm every one of them is listed. If any workspace reports `index_missing`
afterwards, the backfill missed it — re-run the script, which is idempotent,
before investigating anything else.

---

## Out of scope, recorded deliberately

- **Upstream celld fix.** The 49-byte limit is celld's to raise; per the
  standing rule, no upstream issue is filed without asking first. Draft it in
  Markdump if wanted.
- **Other `kv.list` callers.** Task 2 Step 6 surveys them; fixing any is not
  this change, but leaving one unrecorded is the next incident.
- **Re-encrypting or rotating secrets.** Values are untouched; only enumeration
  changes.
- **Concurrent-write safety beyond documenting it.** KV has no CAS, so two
  simultaneous writes can lose an index entry (never a value). Re-running the
  backfill repairs it. A real fix means a different store for the index.
