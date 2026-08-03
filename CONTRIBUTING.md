# Contributing

Issues and pull requests are welcome. This file is the dev loop and the traps;
[`docs/architecture.md`](./docs/architecture.md) is the system, and
[`AGENTS.md`](./AGENTS.md) is the conventions — including the design system, which
a UI change is expected to follow.

## Setup

```bash
pnpm install
cp .dev.vars.example .dev.vars
pnpm run db:migrate:local
pnpm run dev        # Worker on :8787
pnpm run web:dev    # SPA on :5173, second terminal
```

`.dev.vars` needs `BETTER_AUTH_SECRET`, `TOOL_APPROVAL_SECRET` and at least one
model provider key. Set `DEFAULT_SANDBOX_PROVIDER=mock` so compute tools run
against the in-memory backend — no Daytona or Cloudflare credentials needed.

**Never commit `.dev.vars`, tokens, or API keys.**

## Before you open a PR

```bash
pnpm run typecheck
pnpm run lint
pnpm run fmt:check
pnpm vitest run --project unit --project web-unit
```

CI runs the same checks plus integration.

## Traps worth knowing

**`pnpm run check` chains the full test suite** and will OOM a machine with
less than ~8 GB. Run `typecheck`, `lint` and `fmt:check` individually instead.

**Tests are four vitest projects**, not one: `unit`, `web-unit`,
`integration-fast`, `integration-isolated`. `pnpm test` does not run `web-unit`.
Always pass `--fileParallelism=false` for the integration projects — the workers
pool is memory-hungry and parallel files will exhaust a small box. If a
workers-pool run dies, check for stray `workerd` processes.

**`web/` is excluded from the root formatter** (`.prettierignore`). `pnpm run
fmt:check` at the root skips it; format `web/` from inside `web/`.

**Migrations are drizzle-generated.** Edit `src/db/schema.ts`, then
`pnpm run db:generate`. Never hand-edit the SQL in `migrations/`. If two PRs
generate the same migration number, rebase and regenerate — do not renumber by
hand. Table-rebuild migrations (`__new_` tables) can pass locally and fail
against a populated remote D1; prefer additive changes.

**`worker-configuration.d.ts` is committed and not auto-regenerated.** After
changing bindings, run `pnpm types`.

**CI gates `fmt:check` before tests**, so a formatting failure means zero tests
ran — a red run is not necessarily a broken test.

## Pull requests

- Branch from `main`; one concern per PR.
- Explain _why_ in the description. The diff shows what changed.
- Include tests for behaviour changes. A test that cannot fail is not a test —
  break the code deliberately and confirm the test notices.
- If you change UI, say what you looked at. The mocked app
  (`web/mock.html?scenario=…`) renders real components against fixtures and is
  the fastest way to see a change; see `AGENTS.md` for the scenario list.
- If a change makes an existing test wrong, update the test and say so in the
  description. Do not delete around it.

## Reporting security issues

Privately, via [`SECURITY.md`](./SECURITY.md) — never a public issue.
