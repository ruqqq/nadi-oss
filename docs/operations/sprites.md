# Sprites compute — operations runbook

Nadi's third compute provider. A workspace's threads run their agent tools (exec,
file read/write/patch) inside a sprites.dev container, one per thread, backed by
the sprites.dev REST + WebSocket API. This document covers provisioning,
deployment, and the live smoke checklist.

## 1. Infrastructure provisioning

Sprites.dev operates on organization-level tokens. An operator needs one API key
per Nadi deployment.

**Get the API key from sprites.dev/account.** The key is a bearer token in
`Authorization` headers and also appears in `SPRITES_API_KEY`. It is
organization-scoped, not workspace or project-scoped, so all compute for a given
Nadi deployment uses one shared key.

**Store it as a Cloudflare secret:**

```bash
pnpm wrangler secret put SPRITES_API_KEY
```

Paste the key when prompted. Never commit it or log it; the secret is stored in
Cloudflare's vault and bound to the Worker at deploy time.

- **System mode vs. BYOK.** A workspace can use Nadi's organization account
  (system mode) or bring its own sprites.dev API key (BYOK, via workspace
  settings). System mode uses the `SPRITES_API_KEY` secret above. BYOK stores
  the key in a workspace secret (`apiKeySecretName` in the provider config).
  The backend infers the mode from secret-metadata presence — no stored
  configuration state needed.

- **Quota gating.** System mode is quota-gated by `MAX_ACTIVE_CONTAINERS_PER_WORKSPACE`
  in the D1 ledger (`src/compute/container-ledger.ts`). When a workspace hits the
  cap, the least-recently-used idle container is reclaimed before the request is
  refused. BYOK workspaces use sprites.dev's native concurrency limits (the plan
  your account holds caps the number of concurrently RUNNING sprites); the
  application quota is only enforced for system-provided keys.

## 2. Deploying

Sprites needs no container image, so there is nothing here like the Docker
build that `docs/operations/cloudflare-sandbox.md` describes — the deploy is the
ordinary one:

```bash
gh workflow run deploy.yml --ref main
```

Production ships from the private overlay repo, which pins this repo as a
submodule; the pinned commit **is** the deployed version. A change merged to
`main` here is not live until that pointer is bumped and pushed there (see the
overlay's README), and reverting the pin is the rollback. The overlay's workflow
copies `wrangler.prod.jsonc` in and runs the build with this repo as the working
directory.

Before the first sprites-backed deploy:

- `SPRITES_API_KEY` must be set as a Worker secret (`pnpm wrangler secret put
  SPRITES_API_KEY`), or every system-mode acquire fails with a missing-secret
  error. BYOK workspaces do not need it.
- `DEFAULT_SANDBOX_PROVIDER=sprites` is a valid deployment default: new
  workspaces then get the sprites provider instead of `cloudflare` (unset falls
  back to `cloudflare`; local dev uses `mock`). Existing workspaces keep the
  provider stored on their sandbox settings row.

## 2b. Workspace credentials and the connection test

- **BYOK secret name:** `sandbox:sprites` (the `apiKeySecretName` on a sprites
  provider config). It is a workspace secret, stored encrypted, never returned.
- **Routes:** `PUT /api/settings/sandbox/sprites-secret` saves a workspace key
  and puts the workspace in BYOK mode (the request's `secretName`, if sent, must
  match the configured one). `DELETE /api/settings/sandbox/sprites-secret`
  clears it, returns the workspace to system mode, and resets the provider
  config plus `idleTimeoutMs` to their defaults (900000 ms).
- **"Test connection"** for sprites is a LIST probe, not an acquire: the server
  runs an authenticated `GET /v1/sprites` (`listSprites(1)`) and returns
  `{ok:true, provider:"sprites"}`. **It creates no sprite and therefore bills
  nothing** — it proves only that the key is accepted and the API reachable.

## 3. No auto-destroy: the critical warning

**Sprites.dev has NO auto-destroy. A sprite lives until something DELETEs it.**
If a sprite is created and then abandoned (the Worker crashes mid-acquire, a
recovery reference is never cleaned up), **the sprite keeps billing storage
forever**. This is not a Nadi bug — it is how sprites.dev works.

Two mechanisms guard against it:

- **A failed acquire deletes what it created.** `acquire()` wraps everything
  after `createSprite` in a `try/catch` that issues a best-effort
  `deleteSprite` and then rethrows the original error
  (`src/compute/backends/sprites.ts:108-114`). Not a `finally` — a successful
  acquire must keep its sprite.
- **A recoverable release is destroyed on a TTL.** `release({disposition:
  "recoverable"})` makes NO provider call (hibernation is automatic), so the
  sprite is only reclaimed by the service layer's alarm chain: `armAlarm` →
  the Durable Object `alarm` → `cleanupExpiredRecovery` →
  `backend.destroy(recoveryRef)`
  (`src/compute/thread-service.ts:2382-2393`).

**That `destroy()` call is what STOPS STORAGE BILLING.** Orphaned sprites are a
data leak until explicitly deleted.

## 4. Real-provider smoke checklist

Every claim below that depends on a live sprites.dev account or a live Worker is
verified by the live smoke gate: `POST /api/debug/sprites-smoke`, which runs the
end-to-end test defined in `src/compute/backends/sprites-smoke.ts`. Run this
checklist once before trusting sprites compute in production.

**Prerequisites:**

- `.dev.vars` must have `SPRITES_API_KEY`. Paste the key from sprites.dev/account
  — there is no way to read a Cloudflare secret's VALUE back
  (`pnpm wrangler secret list` only confirms that the name is set).
- `.dev.vars` must have `DEBUG_TOKEN` (generated by `scripts/setup-local-env.mjs` or pasted from CI logs).
- Database migrations and web build must be up to date.

**Run the smoke gate:**

```bash
pnpm run db:migrate:local
pnpm run web:build
pnpm run dev
# In another terminal:
curl -s -X POST -H "x-debug-token: $DEBUG_TOKEN" http://localhost:8787/api/debug/sprites-smoke | jq
```

Every step in the response must show `"ok": true`. If any step fails, the error
detail is in the step's `detail` field.

A full run takes roughly two minutes — step 7b deliberately idles 45 s (see
below), so a long run is not by itself a symptom.

The smoke test covers:

0. **Connection probe**: `listSprites(1)` — the exact call "Test connection" makes — parses, before any sprite exists.
1. **Acquire**: sprite created, memory policy set, network policy set, `/workspace` mkdir succeeds.
2. **Exec framing**: `runCommand` delivers stdout correctly; the `medium` memory limit is also accepted (step 2b).
3. **Egress policy**: allow-listed hosts (github.com, *.githubusercontent.com) pass; others are denied.
4. **Process tracking**: `startProcess` spawns a long-running command; `getProcessStatus` reports it running; a socket disconnect doesn't crash the monitoring.
5. **Sentinel files and signals**: process stdout/stderr/exit-code are written to `/tmp` sentinel files (proven pattern from Daytona); `stopProcess(kill)` (SIGKILL) and `stopProcess(terminate)` (SIGTERM) both stop the process; a `stdin` payload reaches the process and comes back through the out sentinel.
6. **File ops**: write, read, move (with overwrite), delete, and list round-trip correctly; a subdirectory lists as `type: "directory"` (the is-dir field is really being read); and both no-overwrite refusals — `writeFile({overwrite:false})` over an existing path, `movePath(overwrite:false)` onto an existing destination — reject and leave the target untouched.
7. **Large payload framing**: WebSocket message coalescing/splitting under ≥256KB stdout is detected and fails the test if it corrupted the output.
8. **Hibernate/wake**: recoverable release, then a **45 s idle wait** past the provider's ~30 s hibernation threshold (step 7b — its own step so the cost is attributable), then re-acquire with the same sprite; a file written before the release survives the round-trip. Without the wait, nothing would actually have hibernated.

### Three recorded unknowns

The smoke test records three assertions about the provider's behavior that were
built before live verification:

- **Step 4a (session command echo):** Does the raw session list include the full command string, or is it truncated? The backend's `getProcessStatus` matches sessions by substring on `command` (the process id is embedded in the command). A truncated echo would cause every long-running process to wrongly report `"failed"`.
- **Step 5b (post-SIGKILL state shape):** After `killSession` with SIGKILL, does `getProcessStatus` return `{status: "failed"}` (the wrapper was killed before it could write an exit code to the rc file) or `{status: "exited", exitCode: N}` (the shell survived the kill and wrote a code)? The backend handles both arms; the test records which one sprites.dev actually returns.
- **Step 6f (WebSocket frame boundaries):** Under a ≥256KB stdout, is the output byte-exact, or does WebSocket message coalescing/splitting corrupt or truncate it? The test sends deterministic base64 and checks byte count and content.

If a later debugging session uncovers a different answer for any of these, the
test can be read as a record of what the provider was observed to do at this
shipment point. See the step comments in `src/compute/backends/sprites-smoke.ts`
for the full details.
