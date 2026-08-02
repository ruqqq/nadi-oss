# Local Development Runbook

## Database migrations (Drizzle-first)

Nadi uses **Drizzle Kit as the single source of truth** for database schema.
SQL in `migrations/` is always drizzle-generated — never hand-edited.

### Role of each tool

| Tool                                    | Role                                                                                                                                                                                                                         |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `drizzle-kit generate`                  | Compares `src/db/schema.ts` to the last snapshot and emits new `.sql` migration files. This is the **only** way new SQL enters `migrations/`.                                                                                |
| `wrangler d1 migrations apply --local`  | **Applies** the drizzle-generated SQL files to the local D1 SQLite database stored in `.wrangler/state/`. Wrangler is the runner; the SQL itself is authored by drizzle.                                                     |
| `wrangler d1 migrations apply --remote` | Same as above, targeting the live Cloudflare D1 database.                                                                                                                                                                    |
| `drizzle-kit migrate`                   | Alternative remote apply path using the `d1-http` driver. Requires `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_DATABASE_ID`, and `CLOUDFLARE_D1_TOKEN` env vars. Use this if you want a pure-drizzle remote apply without wrangler. |

> **Rule:** Do not edit any `.sql` file inside `migrations/` by hand.
> If a migration needs correction, modify `src/db/schema.ts` and re-run `db:generate`.

---

## Workflow: changing the schema

```
# 1. Edit src/db/schema.ts
# 2. Generate a new migration
pnpm run db:generate        # → creates migrations/XXXX_<slug>.sql

# 3. Review the generated SQL (read-only — do NOT edit it)
cat migrations/XXXX_<slug>.sql

# 4. Apply locally
pnpm run db:migrate:local   # applies all pending drizzle-generated migrations to local D1

# 5. Run the full check suite
pnpm run check

# 6. Commit schema + migration together
git add src/db/schema.ts migrations/
git commit -m "db: add <what changed>"

# 7. Deploy to remote D1 (CI/CD or manually)
pnpm run db:migrate:remote  # requires wrangler to be authenticated (wrangler login)
# OR, if you prefer the drizzle d1-http path:
# CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_DATABASE_ID=… CLOUDFLARE_D1_TOKEN=… pnpm run db:migrate
```

---

## Available db:\* scripts

| Script                       | Command                                               | When to use                                                                    |
| ---------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------ |
| `pnpm run db:generate`       | `drizzle-kit generate`                                | After editing `src/db/schema.ts` — generates migration SQL                     |
| `pnpm run db:migrate:local`  | `wrangler d1 migrations apply nadi-registry --local`  | Apply pending migrations to local D1 (non-interactive, safe to run repeatedly) |
| `pnpm run db:migrate:remote` | `wrangler d1 migrations apply nadi-registry --remote` | Apply to live Cloudflare D1 (requires `wrangler login`)                        |
| `pnpm run db:migrate`        | `drizzle-kit migrate`                                 | Remote apply via drizzle d1-http driver (requires `CLOUDFLARE_*` env vars)     |
| `pnpm run db:check`          | `drizzle-kit check`                                   | Validate that the migration journal is consistent with the schema snapshots    |

---

## Fresh local setup

```bash
pnpm install
pnpm run db:migrate:local   # bootstraps the local D1 from the drizzle-generated migrations
pnpm run dev
```

---

## Environment

Copy `.dev.vars.example` to `.dev.vars` and fill in local secrets. Provider credentials are not Worker secrets: store `openai`, `anthropic`, and `openrouter` API keys encrypted in `SECRETS_KV` under `provider:<provider>` for the workspace that owns the registered thread, unless `provider_configs.secret_name` overrides the name. Local agent testing requires a `thread_index` row for the Durable Object name and an `agents` row carrying the runtime provider/model; `DEFAULT_WORKSPACE_ID` is not used as a ThreadAgent runtime fallback, and `DEFAULT_MODEL_PROVIDER`/`DEFAULT_MODEL` are bootstrap defaults for seed agents. New manual threads are always created on Think. Existing legacy threads keep their stored `thread_index.runtime` and open as read-only history. For the OpenAI OAuth testing provider, set `DEFAULT_MODEL_PROVIDER=openai-oauth`, `SECRETS_STORE_KEK_RAW_B64`, and `OPENAI_OAUTH_SECRET_NAME`; store the OAuth token JSON encrypted in `SECRETS_KV`. Clean egress is available to `openai-oauth` and `opencode-zen`: each takes a per-workspace proxy route (`provider_configs.config_json.proxyUrl`, e.g. `https://proxy.example.com/opencode-zen`) and is used when `EGRESS_PROXY_TOKEN` is also set. The proxy itself is `infra/egress-proxy/server.mjs`, whose `ROUTES` table names every upstream it will relay to. Set `CODEX_DIRECT_ENABLED=true` only when explicitly testing direct Cloudflare Worker egress to `chatgpt.com/backend-api/codex`.

Use `pnpm run secret:put` to seed a workspace secret. Required env vars: `WORKSPACE_ID`, `SECRET_NAME`, `SECRETS_STORE_KEK_RAW_B64`, and `KV_NAMESPACE_ID`. Pass the plaintext through stdin or `SECRET_VALUE_FILE`; `SECRET_VALUE` is also supported for automation but is easier to leak through shell history and process environments. Set `LOCAL=1` to write to the local Wrangler KV store instead of remote.

---

## Notes

- `db:migrate:local` auto-confirms the "apply N migrations?" prompt in non-interactive shells (wrangler uses the fallback `yes`). No `--yes` flag is needed.
- The local D1 database lives in `.wrangler/state/v3/d1/` (gitignored).
- `drizzle.config.ts` points to the `d1-http` driver with `CLOUDFLARE_*` env vars for remote apply; local apply bypasses those credentials entirely (wrangler uses its own auth + local SQLite).

---

## Daytona sandbox execution

Sandbox execution is optional. Configure it from Settings → Sandbox.

The Daytona API key is stored in the existing workspace DEK+KEK encrypted KV secret store under `sandbox:daytona` by default. Do not place the Daytona API key in D1 or in model-visible prompts.

When sandbox execution is disabled or incomplete, Nadi hides all `exec_*` tools from the model and does not schedule sandbox eviction alarms.

### Network restrictions

Per-workspace, opt-in from Settings → Sandbox. When "Restrict sandbox network" is on, sandboxes are created with a domain allowlist = a curated baseline (or the workspace's own list) ∪ agent domains ∪ the hosts of enabled MCP servers. This REPLACES Daytona's org-level default allow list (verified: `domainAllowList` is a replace, not an extend). When off, sandboxes inherit Daytona's org default.
