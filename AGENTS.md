# Repository Guidelines

## Project Shape

Nadi is a Cloudflare Worker plus React 19 SPA. Backend code lives in `src/`,
frontend code lives in `web/src/`, database migrations live in `migrations/`,
and integration/unit tests live under `test/`. The Worker uses Durable Objects,
D1, Drizzle, Better Auth, the Vercel AI SDK, Cloudflare Agents/Think, and
policy-gated MCP tools.

Agent skills live in `.codex/skills`. `.claude/skills` is a compatibility
symlink back to that canonical directory.

## Development Commands

- Install dependencies with `pnpm install`.
- Run the Worker locally with `pnpm run dev`.
- Run the frontend locally with `pnpm run web:dev`.
- Run tests with `pnpm test`; pass paths for focused runs.
- Run type checks with `pnpm run typecheck`.
- Run formatting/lint checks with `pnpm run check`.

Vitest has six projects: `unit` (`test/unit/**`), `web-unit` (`web/src/**/*.test.ts`
plus `test/unit/web/**`), `integration-fast`, `integration-grouped` (the heavyweight
DO suites — think-thread-agent, work-ledger, ...), `integration-shared`, and
`integration-isolated`. Only a bare `pnpm test` runs all six — `test:unit` and
`test:integration` together still miss every `web/src` test. Verify with `pnpm
test`, not with the scripts. `vitest.config.ts` also carries a coverage guard
that fails any vitest invocation if a `test/**/*.test.ts` file matches no
project (or more than one) — that is what keeps a newly-added suite from
silently never running.

## Database Rules

Schema is defined in `src/db/schema.ts`. Do not hand-edit generated migration
SQL. After schema changes, run `pnpm run db:generate`, then apply locally with
`pnpm run db:migrate:local`. Remote migrations use `pnpm run db:migrate:remote`.

`worker-configuration.d.ts` is committed intentionally. Regenerate it only from
a checkout that has a complete `.dev.vars`, then commit the result with the
binding change.

## Code Style

Follow the existing TypeScript style and local helper APIs. Keep changes scoped
to the requested behavior, avoid unrelated refactors, and preserve unrelated
worktree changes. Prefer focused tests near the behavior being changed.

Use `rg` for searching. Keep comments short and only where they explain
non-obvious behavior.

Changing an API contract — a new `/api/*` route, a new or newly-required field
on a payload type, a changed response shape — means updating the mocked app in
the same change. See "Keeping the mocks current" below.

## Runtime invariants (both platforms)

Nadi runs on Cloudflare and on self-hosted celld. Nothing below is enforced by
the type system, and each one cost a production incident or a broken feature.

- **Never call a backend from inside `ctx.blockConcurrencyWhile`.** celld kills a
  _successful_ outbound WebSocket upgrade held in the gate ("handler stalled:
  awaited work with no pending op"), and on Cloudflare a long call in the gate
  freezes every other event on the object and, past ~30s, cancels the callback
  and RESETS the object — one `exec` held it 154s and did exactly that. Sandbox
  provisioning is serialized by the `acquisitionInFlight` latch, NOT the gate
  (`ThreadComputeService.ensureRuntime`); teardown paths call the backend
  directly rather than routing through `ensureRuntime`. The gate is fine for
  storage-only work.
- **Outbound WebSocket upgrades must use `wss:`/`ws:`, never `https:`/`http:`.**
  workerd accepts either, so the http form works on Cloudflare and hides the
  bug; celld dispatches on scheme and rejects it before the request leaves the
  isolate. REST keeps the base URL verbatim — only the upgrade is rewritten
  (`execUrl` in `src/compute/backends/sprites-client.ts`).
- **Alarm handlers must be idempotent.** celld replays an alarm on every
  stall-retry; one armed alarm has been observed running 7 times. celld v0.2.1,
  v0.3.0 and v0.4.0 all claim fixes here (a lost reschedule, overlapping
  handlers, and an expired handler settling its own alarm claim), unverified on
  this deployment — keep writing them idempotent.
- **Two adjacent versions must accept each other's Durable Object calls.** Since
  celld v0.4.0 a node adopts a new deployment WITHOUT restarting, and during the
  switch a request on the old deployment can call an object already running the
  new one. Cloudflare has always had this window on rollout; on celld it is now
  every deploy. A new or newly-required field on an RPC payload, or a changed
  stored shape, has to land in two releases — add and write it, ship, then read
  it. This is the seam the Workbenches wire-contract regressions came through.
- **Clear every `setInterval` before the handler ends.** celld keeps the request
  alive while an interval is live, so a stray one pins the request open. This is
  why the subagent liveness timer is bound to the turn and cleared on settle
  (`src/agent/subagent.ts`). Note `setInterval` _threw outright_ on celld before
  v0.3.0 (denoland/celld#156). That timer is unreachable on celld regardless —
  subagents need Durable Object facets, which celld does not implement — so the
  rule matters for the Cloudflare path and for any interval added later.
- **Never let an error message carry a URL that holds secrets.** The sandbox
  exec URL carries `env=` for every workbench secret plus `GH_TOKEN`. Truncate
  at the first URL-ish marker rather than stripping — truncating cannot leak on
  a runtime whose phrasing we have never seen (`redactTransportError`).
- **A platform divergence gets a named capability, not a platform check.** Add it
  to `PlatformCapabilities` in `src/edition.ts` and branch on the capability, so
  each divergence has one honest name and one place to flip. Gate SELECTION on
  the server too, not just in the UI — hiding an option does not stop a
  hand-rolled `PUT` (see `containerSandbox`, `mockSandboxEnabled`).

See `docs/self-hosting-celld.md` for celld's durability posture and its known
defects.

## Design System (web)

The SPA uses the **Dispatch** design language — warm, editorial, calm — built on
shadcn/ui + AI Elements primitives, Tailwind v4, and Phosphor icons. Match it;
don't invent parallel styling.

- **Tokens** live in `web/src/index.css` as CSS variables mapped into Tailwind's
  `@theme`. Use semantic utilities (`bg-background`, `bg-card`, `text-foreground`,
  `text-muted-foreground`, `border-border`, `bg-primary`) — never hardcoded hex.
  Nadi adds `--approve` / `--reject` / `--gate` / `--steer` (+ `-foreground`
  / `-bg`) for intent colors. `--primary` is the aubergine accent.
- **Type**: `font-sans` (Inter) for UI/body; `font-display` (Fraunces) for
  editorial headings and entity names; `font-mono` (JetBrains Mono) for config
  and code-ish values — ids, paths, URLs, branches, commands.
- **Icons**: import from `web/src/icons.tsx` (never from `@phosphor-icons/react`
  directly) so the used set stays in one place; the bold weight is set globally
  in `main.tsx`.
- **Components**: shadcn primitives in `web/src/components/ui/`, AI Elements in
  `web/src/components/ai-elements/`. Merge classes with `cn()` from `lib/utils`.
- **Dark mode**: a `.dark` class on `<html>` (set pre-paint by `lib/theme.ts`).
  Style both themes; verify both.

### Patterns

- **Responsive surfaces**: bottom `Sheet` on mobile
  (`useMediaQuery("(max-width: 640px)")`), anchored Popover / right `Sheet` /
  `Dialog` on desktop — see `ProjectPicker`, `ThreadDetailsSheet`,
  `AddRepositoryPicker` (`web/src/settings/WorkbenchRepositories.tsx`).
  Mobile bottom sheets add `pb-[env(safe-area-inset-bottom)]` and lift above the
  keyboard via `useVisualViewportInset`.
- **Master-detail panels** collapse to a drill-down below `lg` via a
  `useMediaQuery` gate (`ProjectsPanel`).
- **Detail forms**: group fields into titled cards with a one-line purpose hint,
  under an editorial heading (small uppercase eyebrow + `font-display` title);
  use mono inputs for config values (`ProjectsPanel`).
- **Errors are human-readable**: throw via `errorFromResponse`
  (`web/src/lib/http-error.ts`) — surface the server's message or a friendly,
  action-specific fallback, never a raw HTTP status code.
- **Layout**: all `ScrollArea`s are vertical; a global rule in `index.css` forces
  the Radix viewport wrapper to `display:block` so content can't bleed past the
  right edge.

### Visual verification

One service worker ships (`web/src/sw.ts`): it precaches the built shell (so an
offline cold launch renders) and carries the push handlers. It must stay one —
two workers cannot share scope `/`, and a `PushSubscription` belongs to its
registration. It is also the single update mechanism (`skipWaiting` +
`clientsClaim`, reload-on-activate in `lib/register-sw.ts`); never add a second
one. Never cache `/api/*`, `/agents/*`, `/think-agents/*`, `/live`, or any
non-GET. For no-backend visual QA the default is the mocked app
(`pnpm run web:mock`, served at `mock.html?scenario=...`): the real shell,
routing, and components run against MSW handlers over an in-memory store
(`web/src/mocks/`), so data-driven screens and flows are exercised for real.
Navigate in-app — `mock.html` rewrites the URL to `/`, so a hard reload on a
deep route falls through to `index.html` and the sign-in gate. The preview
harness (`web/src/preview.tsx`, `preview.html?screen=...`) remains only for
transient component states no backend mock can drive — upload failures,
permission prompts, half-dragged sheets, offline copy. Screenshot either
with Playwright across desktop/mobile and light/dark. Two Playwright gotchas:
its entry is CommonJS, so `import pkg from ".../playwright/index.js"; const
{ chromium } = pkg` (a named import fails), and force the theme by setting
`localStorage["nadi-theme"]` to `light`/`dark` in an `addInitScript` before load
(the app reads it pre-paint; there is no `?theme=` param). Note: `oxfmt` does not
format `web/` — the enforced web gate is `oxlint` + `pnpm run web:typecheck`.

Driving the browser is the FINAL verification step, not an inner-loop one. Each
run costs a dev server, a browser launch, and a screenshot round-trip per state,
and it is the slowest signal in the repo. Iterate against `web:typecheck` +
`oxlint` and reason from the code; boot Playwright once the change is believed
complete, to confirm what you built actually renders. The corollary is that it
is not optional either — typecheck cannot see response-shape drift or a state
no scenario reaches, so a UI change still has to be looked at before it ships.

### Keeping the mocks current

The mocked app is only worth trusting while it matches the real contract, and
nothing keeps it honest automatically. Extend it in the same change that
changes the contract:

- **New or changed `/api/*` route** → add/update the handler in
  `web/src/mocks/rest/`. `web/src/mocks/rest/index.ts` is the registry.
- **New field on a payload type** → update `web/src/mocks/store.ts` and the
  `make*` helpers in `web/src/mocks/scenarios/index.ts`. A newly-_required_
  field breaks `web:typecheck` and is loud; an _optional_ one is silent, so the
  mock renders a state the real app can no longer produce.
- **Mutations must mutate.** Handlers write to the store so lists reflect
  creates, renames, and archives — that is what makes flows testable.
- **New agent RPC** (`agent.call(...)`) → add a canned return in
  `web/src/mocks/chat/fake-thread-chat.ts`. Unknown methods resolve `undefined`
  and `console.warn`; keep that channel meaningful by not letting known-good
  calls fall into it.
- **A scenario may inject failures**, via `MockFaults` on the store rather than
  by sniffing the seeded rows. Note which failure you need: a non-ok status is
  degraded to an empty transcript by `thread-history-fetch.ts`, so only a
  transport-level failure (`HttpResponse.error()`) trips
  `ThreadHistoryErrorBoundary`.
- **New UI state that data can drive** → prefer seeding a scenario over adding
  a `preview.tsx` screen. Only one screen is still parked there for lack of a
  scenario: `history-error`, and only its **offline** copy — that wording is
  gated on `useOffline()`, which the app derives from a bootstrap probe
  failing, and no seeded scenario can produce it while MSW answers everything.
  Its online copy and both header escapes now come from
  `?scenario=history-error` (`thr_001` from the list → rail toggle; `thr_021`
  opened from the Nightly digest's run → Back arrow).

Typecheck is a partial guard, not a safety net: it catches required-field drift
in the fixtures and nothing else. Response _shape_ drift is invisible to it —
`/api/bootstrap` already returns a wire shape that differs from `BootstrapData`
(`features: {voiceInput, workersAi}`, nested `session`), and a handler that
silently stops matching would still compile. Drive the screen.

Mock code must never reach production. `scripts/check-mock-isolation.mjs` (run
in CI) fails if anything outside `web/src/mocks/` or `web/src/mock-main.tsx`
imports `mocks/` or `msw`. `web/public/mockServiceWorker.js` is gitignored
deliberately — when present it lands in the PWA precache manifest; regenerate
it with `pnpm run web:mock`.

## Secrets

Never commit `.dev.vars`, local env files, auth tokens, API keys, or debug
tokens. Debug endpoints require `x-debug-token: <DEBUG_TOKEN>` and should remain
token-gated.

## Cursor Cloud specific instructions

The startup update script runs `pnpm install` (root + `web` workspace) then
`node scripts/setup-local-env.mjs`, which idempotently creates the local env
files if missing: `.dev.vars` (the offline `mock` model + `mock` sandbox, plus
generated `BETTER_AUTH_SECRET`/`TOOL_APPROVAL_SECRET`/`SECRETS_STORE_KEK_RAW_B64`)
and `web/.env.local`. Both are gitignored; the script never overwrites an
existing file, so generated secrets and your edits are stable across runs.

Standard commands (`pnpm test`, `pnpm run typecheck`, `pnpm run lint`, `pnpm run
web:typecheck`, `pnpm run web:build`) work as documented above. `pnpm test` runs
all four Vitest projects and passes; the workerd stack traces it prints (e.g.
"test eviction", "WebSocketPipe was destroyed") are expected error-path
assertions, not failures.

### Local vs prod wrangler config

`wrangler.jsonc` is the LOCAL-default config and `pnpm run dev` (`wrangler dev
--local`) runs fully local with NO Cloudflare credentials: R2 is a local sim (no
`remote: true`), and sandbox containers are disabled via `dev.enable_containers`
(they need Docker). `wrangler.prod.jsonc` is the production override — same
bindings but `remote: true` on the R2 attachments bucket and containers enabled —
used by `pnpm run deploy` and `pnpm run types` (both pass
`--config wrangler.prod.jsonc`). Keep the two in sync when editing bindings.

The `AI` (Workers AI) binding is always remote, so `wrangler dev` WITHOUT
`--local` tries to open an authenticated remote-proxy session and fails with "Could
not start remote dev session" — always use `pnpm run dev` (which passes `--local`).

### Running the app

```bash
pnpm run db:migrate:local   # bootstrap local D1 (idempotent)
pnpm run web:build          # the ASSETS binding needs web/dist to exist before wrangler dev
pnpm run dev                # Worker → http://localhost:8787 (serves the built SPA same-origin)
pnpm run web:dev            # optional: Vite dev SPA → http://localhost:5173 (cross-origin)
```

### Sandbox: the `mock` provider

Local dev defaults new workspaces to the in-memory `mock` compute provider
(`DEFAULT_SANDBOX_PROVIDER=mock`), so the sandbox + `exec_*`/file tools work with
no Daytona key, no Docker, and no R2. It is selectable in Settings → Sandbox as
"Mock (local dev)", and `POST /api/settings/sandbox/test` returns
`{ok:true, provider:"mock"}`. Its state (`src/compute/backends/mock.ts`) is
process-global and resets on a `wrangler dev` reload. Production is unaffected —
`DEFAULT_SANDBOX_PROVIDER` unset falls back to `cloudflare`.

### Auth + chat-model gotchas

- **Email-OTP sign-in with no Resend key**: the local send-email binding writes
  the email body (with the 6-digit code) to a file instead of sending it. Read
  the newest one: `cat "$(ls -t /tmp/miniflare-*/email/email-text/*.txt | head -1)"`.
  Any email works (`WHITELISTED_EMAILS` empty = open); whoever is listed in
  `SUPERUSER_EMAILS` is a superuser. New arbitrary emails are waitlisted
  (invite-only) — use a superuser or whitelisted address.
- **The `mock` MODEL provider is not offered in the composer's model picker** —
  the UI only surfaces providers with a usable key or the Workers AI catalog
  (gated by `WORKERS_AI_EMAILS`), and Workers AI needs the remote `AI` binding
  (unavailable locally). So a UI-created thread can't get a reply offline. To
  drive the offline `mock` model (it echoes `Echo: <your text>`), point an
  existing thread's registry row at it and send another message in that thread —
  `resolveRuntimeConfigForThink` re-reads `thread_index` every turn:
  `pnpm exec wrangler d1 execute nadi-registry --local --command "UPDATE thread_index SET model_provider='mock', model='mock' WHERE id='<thread-id>';"`
