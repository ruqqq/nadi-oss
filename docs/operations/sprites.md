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

- **Quota gating.** System mode is quota-gated by
  `MAX_ACTIVE_AGENT_SANDBOXES_PER_WORKSPACE` in the D1 ledger
  (`src/compute/agent-sandbox-ledger.ts`). The unit is a concurrently live
  AGENT. When a workspace hits the cap, the least-recently-used active box is
  asked to hibernate before the request is refused. BYOK workspaces use sprites.dev's native concurrency limits (the plan
  your account holds caps the number of concurrently RUNNING sprites); the
  application quota is only enforced for system-provided keys.

## 2. Deploying

### One-time checklist for the P3 (persistent agent sandbox) deploy

- **`MAX_ACTIVE_CONTAINERS_PER_WORKSPACE` was renamed to
  `MAX_ACTIVE_AGENT_SANDBOXES_PER_WORKSPACE`.** Both wrangler configs in this
  repo are updated, but a value set anywhere OUTSIDE the repo — the private
  overlay's `wrangler.prod.jsonc`, a dashboard var, a celld env file — is now
  read by nothing. The cap silently falls back to the default of 10 and nothing
  fails. Grep every deployment surface for the old name before shipping.
- **Sprites created before this deploy are never reaped by the orphan
  reconciler.** Only names carrying the `nadi-b1-` prefix are eligible, because
  a pre-P3 sprite has no `agent_sandboxes` row and nothing will ever backfill
  one. Legacy sprites stay reachable through their owning Durable Object and
  are deleted by agent deletion; they otherwise bill until then.
- **Nothing auto-destroys a sprite any more.** The daily cron's
  `reconcileOrphanSprites` is the only collector of a strand, and it covers
  system-managed keys only. Watch for `compute.sprite_orphan_reaped` — a steady
  rate is a bug report about the acquire path, not housekeeping — and
  `compute.sprite_reconcile_listed`, whose `returned` plateauing at a round
  number means the provider is paginating and strands are being missed.
- **Run the FIRST cron dry.** Set `SPRITE_RECONCILER_DRY_RUN="true"` for the
  deploy, read every `compute.sprite_orphan_would_reap` line, confirm each names
  a sprite that genuinely has no owner, then unset it. The reaper's first guard
  assumes no pre-existing sprite carries the `nadi-b1-` prefix; that assumption
  has only ever been checked against this repo's code, and the first real pass
  deletes on it. Exactly the string `"true"` enables the dry run — any other
  value reaps for real, so a mistyped flag cannot silently disable the collector,
  and a forgotten one shows up as a steady `would_reap` line rather than silence.

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

### The TTL is the only reclaim path on Sprites

An idle Sprites thread **always** releases as `recoverable`, so the recovery TTL
is what deletes it. The backend declares `nativeIdleSuspend = true`
(`ComputeBackend.nativeIdleSuspend`), and `resolveIdleDisposition` reads that as
"the provider already stopped the compute meter" and skips the two INFERRED
discards — "git says every repo is clean" and "the workspace is empty" — that
apply on Daytona and Cloudflare, where an idle runtime keeps billing because we
disable their native idle handling (`autoStopInterval: 0` / `keepAlive: true`).
On those providers a fast discard stops the meter; on Sprites it would only free
disk, and it has already destroyed a real user's workspace that way. The
decision is logged as `compute.retention_decision` with
`reason: "provider_native_idle"`.

The one exception is an EXPLICIT `confirm_work_saved` declaration, which still
discards immediately — stated intent, not an inference.

So on Sprites, **`recoveryTtlMs` (default 24h) is the lever for disk cost**: it
is how long a hibernated sprite keeps billing storage after its thread goes
idle. Lower it to reclaim sooner; raise it to give people longer to come back to
their work. `idleTimeoutMs` no longer decides whether the work survives here,
only when it hibernates and the TTL clock starts.

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
7. **Large payload framing** (step 6f): a ≥256KB stdout, produced after a deliberate `sleep 2` so the run is STREAMED, arrives byte-exact — coalescing or splitting of WebSocket messages would fail the test. Step 6g is the companion **known-limitation probe** for the 64KiB replay cap below.
8. **Hibernate/wake**: recoverable release, then a **45 s idle wait** past the provider's ~30 s hibernation threshold (step 7b — its own step so the cost is attributable), then re-acquire with the same sprite; a file written before the release survives the round-trip. Without the wait, nothing would actually have hibernated.

## 5. Provider limitations you will meet in production

### `runCommand` output above 64KiB is truncated — but the cut is now DETECTED

The exec WebSocket serves a session down one of two paths, and the server names
which in its `debug` text frames. These are the frames verbatim, live
2026-08-04:

| Debug frame | When | Output |
| --- | --- | --- |
| `{"msg":"normal_path history_len=0","pid":23,"t_ms":17,"type":"debug"}` | we attached BEFORE the command finished | streamed live, complete at any size (349528 bytes over 13 frames) |
| `{"msg":"fast_path attach_err=session has exited exit_code=0 history_len=65536","pid":333,"t_ms":22,"type":"debug"}` | the command had ALREADY EXITED when the socket opened | a RECORDED history, capped at exactly **65536 bytes** |

On the `fast_path` the truncated output still comes back with `exitCode: 0` and
no error, and there is no flag to raise the cap — but an earlier version of this
runbook (and of `execCollect`'s doc comment) claimed there was "no marker in the
result, so nothing can detect it", **and that was false**. The `debug` frame
above is the marker, and `execCollect` already receives and parses text frames.

It now parses this one: a `fast_path` frame whose `history_len` is at the 65536
cap sets `truncated: true` on the exec result, which `SpritesComputeBackend`
propagates as `RunCommandResult.stdoutTruncated` and `ThreadComputeService`
surfaces as the `exec` tool's `stdoutTruncated` — the same flag the
start-and-poll path already uses to tell the model "you did not see all of
this". A fast_path replay UNDER the cap is complete and is not flagged (live:
`history_len=3` for `echo hi`). Smoke step 6g asserts both directions.

Which path a given call takes is a race between the command's runtime and the
upgrade round-trip (~25 ms), so it is **not a stable property of a command**: a
command that produces a lot of output quickly is the exposed case. `sleep 2`
before the output is what the smoke uses to force the streaming path.

**Consequence:** `runCommand` output above 64KiB is still CUT — detection makes
it visible, not complete. The sentinel-file route — `startProcess` then
`readProcessOutput`, which reads the recorded stdout back out of the sandbox
filesystem — has no such cap. In nadi the exposed caller is
`ThreadComputeService`'s foreground `exec` (`src/compute/thread-service.ts`, the
`backend.runCommand(...)` call); its background path already uses
`startProcess`.

### Reading a `sprites_exec_no_exit` — the `after=` field names the side

`provider_transient — sprites_exec_no_exit: code=1006 reason=WebSocket
disconnected without sending Close frame.` means the exec socket ended before
any exit code arrived, so the command's outcome is genuinely unknown.

The code and reason do **not** say who hung up. Measured in workerd
(2026-08-05): a socket **we** abort and a socket the **server** destroys without
a close frame both surface as that exact text — it is workerd's own wording for
any close it did not receive. So the error carries `after=<ms>`, the socket's
lifetime, and that is the field to read:

- **A cluster at one constant** is a timer on our side. This is how the shipped
  bug looked: the exec upgrade's `AbortSignal.timeout(30_000)` stayed armed
  after the handshake, workerd keeps a fetch's signal wired to the connection
  that fetch produced, and for an upgrade that connection *is* the socket — so
  every exec still running at 30 s was killed by our own timeout. Anything
  longer than half a minute (an install, a test run, a clone) failed. Fixed by
  disarming the timer once the handshake answers (`openExecSocket`).
- **A spread that tracks how long each command ran** is the far end hanging up,
  and is a provider matter rather than a clock of ours.

### Session ids are a small per-sprite counter — recycling is an open unknown

The id returned in the server's `session_info` frame is a small integer string,
not a uuid: live ids were `"15"`, `"23"`, `"332"`, `"333"`, `"346"` (and the
`debug` frames' `pid` field carries the same number). `getProcessStatus` and
`stopProcess` both address a session by exact-match on that id.

**Nothing establishes that the counter does not reset when a sprite restarts or
wakes from hibernation.** If ids recycle, a stale process reference could match
a session belonging to a different process, and `stopProcess` would kill an
unrelated one.

Mitigation shipped, deliberately cheap: `stopProcess` reads the per-launch rc
sentinel FIRST (the sentinel is keyed by a uuid, so it cannot be confused) and
returns `{status:"exited"}` without looking at the session listing when the
process already recorded an exit. That removes the exposure for every
already-finished process, which is what a stale reference almost always is. A
reference to a still-RUNNING process whose id was recycled remains theoretically
exposed. A full fix means an identity redesign (verify `command`/`created` on
the session row before signalling it, or stop trusting server ids across a
restart) and has not been done.

### The sprite's create-time `environment` never reaches a command

`POST /sprites` accepts an `environment` map, and a command run in that sprite
sees **none** of it (live probe, 2026-08-04: `PROBE_ENV` set at create,
`echo "[$PROBE_ENV]"` printed `[]`). `SpritesComputeBackend` therefore carries
the runtime environment on the `env` query param of **every exec**, and creates
sprites with no `environment` at all — so no workbench secret or minted
`GH_TOKEN` is written into a provider-side record that nothing reads.

Two consequences worth knowing:

- The `env` param **replaces** the environment rather than extending it, so the
  client re-sends the sprite's own default `PATH`
  (`DEFAULT_EXEC_PATH` in `sprites-client.ts`, read back live — it includes
  `/home/sprite/.local/bin`, where a sandbox's user-installed tools land).
  `HOME` survives a replacement on its own; `PATH` does not.
- Env values ride in the exec URL's query string. That is TLS-protected in
  transit but would appear in any provider-side request log. Moving them into
  `export` lines inside the `startProcess` wrapper would not help — the wrapper
  is sent as `cmd` params on the same URL.

### An rc sentinel can land after the session disappears

`getProcessStatus` reads the `/tmp` rc sentinel first and the session listing
second, and the two are not simultaneous: live, a finished `sleep 8; echo done`
was seen with its stdout sentinel written, its session still listed, and no rc
file — with rc `0` readable ~200 ms later. A single read landing in that window
used to report a successful run as `failed`. The backend now re-reads the
sentinel a few times before answering, and treats a read that *threw* as "not
known yet" (`running`) rather than as proof of absence.

### Three recorded unknowns

The smoke test records three assertions about the provider's behavior that were
built before live verification:

- **Step 4a (session command echo):** Does the raw session list include the full command string, or is it truncated? The backend's `getProcessStatus` matches sessions by substring on `command` (the process id is embedded in the command). A truncated echo would cause every long-running process to wrongly report `"failed"`.
- **Step 5b (post-SIGKILL state shape):** After `killSession` with SIGKILL, does `getProcessStatus` return `{status: "failed"}` (the wrapper was killed before it could write an exit code to the rc file) or `{status: "exited", exitCode: N}` (the shell survived the kill and wrote a code)? The backend handles both arms; the test records which one sprites.dev actually returns.
- **Step 6f (WebSocket frame boundaries):** Under a ≥256KB stdout, is the output byte-exact, or does WebSocket message coalescing/splitting corrupt or truncate it? The test sends deterministic base64 and checks byte count and content. **Answered:** framing is correct on the streaming path; the truncation this step originally caught was the server's `fast_path` replay cap, documented in §5.

If a later debugging session uncovers a different answer for any of these, the
test can be read as a record of what the provider was observed to do at this
shipment point. See the step comments in `src/compute/backends/sprites-smoke.ts`
for the full details.
