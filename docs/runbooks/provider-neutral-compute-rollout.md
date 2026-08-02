# Provider-neutral Compute Rollout Runbook

One-time rollout for the provider-neutral compute foundation (migration
`0027_fantastic_toad_men.sql`). Applies the first time this branch reaches an
environment. After that, this runbook is spent.

> **Rule:** migrate and backfill **before** deploying the Worker. The order is not
> a preference.

## Why the order is strict

`getWorkspaceComputeSettings` (`src/compute/settings.ts`) throws
`missing_provider_config_json` when a `workspace_sandbox_settings` row has a null
`provider_config_json`. It does **not** fall back to the legacy columns — the
plan's constraints forbid dual-read fallback, because a fallback would silently
mask an unmigrated row instead of failing loudly.

So a Worker deployed against an un-backfilled database throws on every workspace
settings read. Compute goes dark for every workspace: no `exec`, no sandbox
creation, no recovery. There is no code path that degrades gracefully. This is
by design; the guard is what makes the backfill verifiable.

Migration `0027` adds `provider_config_json` as nullable, so applying it does not
break the currently-deployed Worker. The backfill is what populates it.

## Steps

Run from a checkout with a complete `.dev.vars`. `CLOUDFLARE_ACCOUNT_ID` must be
set for any `wrangler --remote` command.

### 1. Apply the migration

```bash
pnpm run db:migrate:remote
```

### 2. Backfill provider config

```bash
pnpm run db:backfill:compute:remote
```

Populates `provider_config_json` for every existing
`workspace_sandbox_settings` row from its legacy Daytona columns. Idempotent —
safe to re-run.

### 3. Verify the gate — this is the precondition for deploying

```bash
wrangler d1 execute nadi-registry --remote --command \
  "SELECT count(*) AS unmigrated FROM workspace_sandbox_settings WHERE provider_config_json IS NULL"
```

**Must return `unmigrated = 0`.** A nonzero count means at least one workspace
will throw on its next settings read. Do not deploy. Re-run step 2 and
investigate any row it cannot fill.

Count-zero is necessary but not sufficient. A workspace with neither a snapshot
nor an image backfills to a **non-null** config whose `profiles` are `null` — it
passes the gate above, then fails later at sandbox creation with
`compute_missing_source`. That is fail-closed, not data loss, but find them
first:

```bash
wrangler d1 execute nadi-registry --remote --command \
  "SELECT id FROM workspace_sandbox_settings \
   WHERE json_extract(provider_config_json, '\$.profiles.small') IS NULL \
      OR json_extract(provider_config_json, '\$.profiles.medium') IS NULL"
```

Any row listed needs a snapshot or image set in workspace settings before its
next sandbox launch.

### 4. Deploy

```bash
pnpm run deploy
```

Note `pnpm run deploy`, not `pnpm deploy` — the latter is pnpm's own builtin and
does something else entirely.

## Durable Object state

No operator action. Each thread's Durable Object migrates its own
`sandbox_state` / `sandbox_processes` rows into `compute_state` on first access,
inside a single `storage.transactionSync` guarded by a schema-version marker
written only after every backfill statement succeeds. It is idempotent and
atomic; a DO that never wakes stays on legacy rows until it does.

Backfilled runtime, recovery, and process references are emitted `kind`-tagged so
the Daytona backend can parse them (`{kind: "runtime" | "recovery" | "process",
sandboxId, ...}`). An untagged reference throws `ZodError` on first use and
strands the environment — `test/unit/compute/backfilled-reference.test.ts` pins
this seam. Do not loosen the backend schema to accept untagged payloads.

## Rollback

Deploying the previous Worker is safe: `provider_config_json` is additive and
nullable, and the legacy columns are untouched by the backfill. Durable Objects
that already migrated keep serving from `compute_state`; the old Worker reads the
legacy tables, which still hold their pre-migration values. Threads whose
compute state changed after the DO migration would lose those changes on
rollback — in practice, a running sandbox may be orphaned and need
`exec_shutdown`.
