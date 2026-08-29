# Self-hosting Nadi on celld

Nadi normally runs on Cloudflare Workers. It can also run on your own machine
with [celld](https://github.com/denoland/celld) — a self-hosted Durable Objects
daemon that executes the same Wrangler bundle, backed by an S3-compatible bucket
you own.

This guide is for that second path. **The Cloudflare deploy is unchanged** —
`pnpm run deploy` and `wrangler.jsonc` work exactly as before, and nothing here
affects them.

Every step below has been run end to end. Where something is a trap, it is
called out rather than left for you to discover.

## What works, and what does not

Working: the agent runtime and chat, threads and history, automata, MCP servers
and tools, workspace secrets, attachments and published artifacts, sandboxes via
Daytona or sprites, sign-in, and web push notifications (payloads are encrypted
in-repo with @noble/curves + @noble/hashes + native AES-GCM because celld's
WebCrypto has no ECDH; VAPID is signed with native ECDSA).

**Not working on celld**, because they depend on Cloudflare-managed bindings that
have no equivalent:

| Feature | Why |
| --- | --- |
| Voice input | needs the Workers AI binding |
| Workers AI as a model provider | same — bring your own provider key instead |
| Browser rendering for `web_fetch` | no browser binding; fetch degrades to direct HTTP |
| Attachment vision extraction, `toMarkdown` | needs the Workers AI binding |
| The `cloudflare` sandbox provider | needs Containers; `wrangler.celld.jsonc` binds no sandbox classes |
| Attachment storage via an R2 *binding* | celld v0.4.0 has R2, but its buckets live inside the fleet bucket and cannot presign. Attachments and sandbox backups are handed out as presigned URLs that a browser or a **sandbox** fetches without the Worker in the path, so celld signs S3 directly instead — a deliberate choice, not a gap |
| Subagents (`BACKGROUND_WORK_ENABLED=true`) | the `agents` SDK builds them from Durable Object *facets*, which celld does not implement — see [Upgrading celld](#upgrading-celld) |

Nadi hides these rather than offering something that fails on use — voice and
Workers AI via `platformCapabilities`, and the Cloudflare sandbox via
`containerSandbox`, which the settings PUT enforces too so a hand-rolled request
cannot select it either. **Sandboxes work** on Daytona and on sprites; pick one
in Settings → Sandbox.

**Web push works.** The payload encryption is selected by probing whether
native ECDH is available rather than by platform, and both paths are verified
byte-identical to Cloudflare's. celld gained ECDH `deriveBits`/`deriveKey` on
P-256, so on v0.3.0 the probe takes the native path and the in-repo
`@noble/curves` implementation becomes the fallback rather than the norm — no
configuration change either way. VAPID keys in either common format work: a raw
32-byte scalar (what `web-push generate-vapid-keys` emits) or PKCS#8.

**GitHub App auth works**, though celld's WebCrypto still cannot *sign* with
RSA, so the RS256 JWT that private-repo clone/push needs is signed in-repo with
BigInt. The path is chosen by probing whether the runtime can actually sign
rather than by platform, and is verified byte-identical to the Cloudflare path
in the integration suite.

> **Re-measured on v0.4.0, because the release notes read the other way.**
> v0.4.0's compatibility page lists only RSA-PSS signing as unavailable, which
> reads as "PKCS#1 v1.5 signing works now". It does not. A `celld dev` node on
> v0.4.0 generates the key, exports PKCS#8, and imports it — and then throws
> `NotSupportedError: unsupported sign algorithm: RSASSA-PKCS1-V1_5` on the
> sign. This is the third release where import succeeds and sign refuses, and
> the second time the docs would have talked someone out of the shim that is
> load-bearing. The probe signs rather than merely importing for exactly this
> reason; it takes the in-repo path on its own, with no configuration.

Only PKCS#8 keys are accepted — if your GitHub App key
is PKCS#1 (`BEGIN RSA PRIVATE KEY`), convert it with
`openssl pkcs8 -topk8 -nocrypt -in github-app.pem -out github-app-pkcs8.pem`.

### Two celld runtime constraints the code works around

Both cost every sandbox `exec` on celld before they were found, and neither
shows up on Cloudflare. If you touch this code, keep them in mind — nothing in
the type system enforces either one.

**Outbound WebSocket upgrades must use `wss:`/`ws:`, not `https:`/`http:`.**
workerd accepts either scheme for a client upgrade, so the shape the Cloudflare
docs show works there and hid this. celld dispatches on the scheme and rejects
the http one before the request leaves the isolate ("not a WebSocket scheme:
https"). REST over the same base URL is unaffected — only the upgrade. See
`execUrl` in `src/compute/backends/sprites-client.ts`.

**No backend call may run inside `ctx.blockConcurrencyWhile`.** celld's stall
detector does not count a pending outbound upgrade as pending work, so it kills
a handler that is legitimately waiting on one — "handler stalled: awaited work
with no pending op" — even though the identical upgrade succeeds outside the
gate. Sandbox provisioning is therefore serialized by an in-process latch rather
than the gate (`ThreadComputeService.ensureRuntime`), and teardown paths call
the backend directly rather than routing through `ensureRuntime`. This is worth
keeping on Cloudflare too: a gated acquire freezes every other event on the
thread while a sandbox boots, and overrunning the ~30s budget resets the object
outright.

The same stall detector also re-runs an alarm on every retry, so one armed alarm
can execute several times if it lands while a gate is held. Alarm handlers
should be idempotent.

## Durability: read this before you rely on it

celld restores a cell from your bucket at startup and **discards local-only
state**. Whatever has not reached the bucket when a node dies is gone, even if
the machine itself survives — there is no volume you can add that changes this,
which was verified by killing a node and restarting the same container on an
intact working directory.

What reaches the bucket, and when, has moved twice:

| version | replication cadence |
| --- | --- |
| v0.1.0 | on idle eviction only — a crash lost everything since the cell last went quiet |
| v0.2.0–v0.2.1 | one LTX frame per transaction. Measured here: `SIGKILL` with the container destroyed 0.1 s after the last write lost **0 of 25** registry rows |
| v0.3.0 | as above for a single node. For fleets of **two or more**, a replicated write-behind log acknowledges a write after peer fsync and uploads to the bucket behind it |
| v0.4.0 | unchanged for a single node. The output gate is stronger — read-only output now waits for earlier request or alarm writes to become durable, so a response cannot describe state the bucket has not accepted |

The v0.3.0 write-behind log is the one change that would alter the posture
below, and a single-node deployment does not get it — there is no peer to
fsync to. Read the [multi-node note](#operating) before treating that as a
reason to scale out; it is a real durability argument now, where it was not
before, but it brings a failover story with it.

This remains an accepted trade for a single-user deployment, bounded by the
rules in [Operating](#operating).

> **Historical, and fixed in v0.3.0: concurrent writes could corrupt the
> backup, and draining did not save you.** Under concurrent writes to one cell,
> celld ≤ v0.2.1 could replicate a chain missing pages it referenced. That cell
> then failed every later request with `RestoreFailed` /
> `missing page N in restore plan (incomplete backup)`, permanently. The damage
> happened during the writes, not at shutdown, so no shutdown discipline
> avoided it — only lowering write concurrency did.
>
> On Nadi it presented as *silent* corruption rather than a loud failure: a
> restored registry whose `PRAGMA integrity_check` failed, with rowids out of
> order in `thread_index`, four indexes over it carrying the wrong entry count,
> and an unused page. Every other registry read and write kept working; only
> the thread-list query — the one joining `automata` through a damaged index —
> failed, taking `/api/bootstrap` and `/api/threads` to a 500. **"The app
> mostly works" was never evidence the database was fine.**
>
> celld v0.3.0 closes both halves upstream: denoland/celld#150 (large
> transactions batched into one replication segment losing pages) and #158
> (corruption after eviction and reactivation). Reproduced originally on a
> minimal worker (github.com/ruqqq/celld-incomplete-backup-repro).
>
> **This is read off the release notes, not re-measured here.** The check that
> tells the truth still costs nothing, so keep running it after any
> write-heavy period until you have your own evidence:
>
> ```bash
> D=$(docker exec nadi-celld-celld-1 sh -c 'ls -d /tmp/celld-1/__D1Database*/ltx/*/ | tail -1')
> docker cp "nadi-celld-celld-1:${D}db.sqlite" ./registry.sqlite
> sqlite3 ./registry.sqlite 'PRAGMA integrity_check;'
> ```
>
> Recovery, if it ever recurs, is from your bucket backup. `sqlite3 .recover`
> reads data out of a damaged copy, but there is no supported way to hand a
> repaired file back to celld — it restores from the bucket at startup and
> discards local state.

## Prerequisites

- A machine with Node 22+, `pnpm`, and `git`.
- **celld v0.4.0**: `curl -fsSL https://celld.dev/install.sh | sh` (add
  `CELLD_VERSION=v0.4.0` to pin). This is the version Nadi is built against and
  the one `deploy/celld/Dockerfile` pins. See
  [Upgrading celld](#upgrading-celld) before moving it.
- **An S3-compatible bucket.** [MinIO](https://min.io) is fine and is what this
  was tested against; so is Cloudflare R2 or AWS S3. You need two buckets, or one
  bucket and one prefix: the *fleet* bucket celld replicates into, and an
  *attachments* bucket.
- `esbuild` is resolved automatically from this repo's dependencies. Nothing to
  install. (`celld deploy` wants it on `PATH`; `pnpm celld:deploy` finds the one
  in the pnpm store and names it in `CELLD_ESBUILD` so you do not have to.)

## 1. Create the buckets

With MinIO running locally:

```bash
export AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… AWS_REGION=us-east-1
# create `celld-fleet` and `nadi-attachments` through the MinIO console or `mc`
```

## 2. Configuration

`wrangler.celld.jsonc` in the repo root holds the non-secret configuration and is
committed. **Secrets do not go in it.** Supply them at runtime with a vars file:

```bash
# celld-vars.env — keep this out of version control
SECRETS_STORE_KEK_RAW_B64=<32 random bytes, base64>
BETTER_AUTH_SECRET=<32+ random bytes>
S3_ENDPOINT=http://127.0.0.1:9100
S3_ACCESS_KEY_ID=…
S3_SECRET_ACCESS_KEY=…
S3_ATTACHMENTS_BUCKET_NAME=nadi-attachments
S3_BACKUP_BUCKET_NAME=nadi-attachments
APP_BASE_URL=http://127.0.0.1:8080
SUPERUSER_EMAILS=you@example.com
```

Generate the KEK and auth secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

> **The vars file is `KEY=VALUE` lines, not JSON.** A JSON file is accepted
> silently and delivers nothing — the app then behaves as though every variable
> is unset. Individual `CELLD_VAR_<NAME>=value` environment variables work too.

Already set for you in `wrangler.celld.jsonc`, but worth knowing:
`NADI_PLATFORM=celld`, and **`DEFAULT_MODEL_PROVIDER` + `DEFAULT_MODEL`**. Those
last two are not optional: without them the *first sign-in* fails on a database
constraint after the user row is created, leaving a half-provisioned account.

**`DEFAULT_SANDBOX_PROVIDER` is required, and nothing sets it for you.** It is
not in `wrangler.celld.jsonc`, and unset resolves to `cloudflare` — the one
provider celld structurally cannot run, because it rejects the `containers` and
`r2_buckets` bindings. Every new workspace is then provisioned with a sandbox
whose first use fails, and it takes the *whole message submission* down with it,
not just the sandbox tools:

```
compute_unavailable: cloudflare_config_missing: NADI_SANDBOX_SMALL,NADI_SANDBOX_MEDIUM,…
```

Set it to `sprites` or `daytona` (each needs an API key, here or per-workspace
in Settings), or `mock` for a local trial — an in-memory backend that runs no
real commands and resets on every node restart. `mock` is also gated on this
var: it is offered in Settings *only* where `DEFAULT_SANDBOX_PROVIDER=mock`, and
refused by the API elsewhere, so a production workspace cannot be pointed at a
test double.

The value applies to workspaces created *after* a restart. An existing workspace
keeps what it was provisioned with, and is changed in Settings → Sandbox.

Optional:

- `RESEND_API_KEY` — without it, **outbound mail is a no-op**. Sign-in codes go
  nowhere and a warning is logged saying so.
- `AUTH_OTP_LOG_FALLBACK=true` — writes the sign-in code to the log instead of
  emailing it. **Local development only**: anyone who can read the log can sign
  in as anyone. It is refused outright on the hosted edition.
- `DEBUG_TOKEN` — enables `/api/debug/*` routes, including the cron health
  check below.

## 3. Deploy

```bash
pnpm web:build      # the SPA — celld serves it, so it is part of the deploy
pnpm celld:deploy -- --bucket s3://celld-fleet --endpoint http://127.0.0.1:9100
```

Two commands: build the SPA, then bundle and upload both it and the Worker to
the fleet bucket. `celld deploy` reads the `assets` block in
`wrangler.celld.jsonc` — the same block Cloudflare reads — so the static shell
and the Worker ship together as one deployment.

`pnpm celld:deploy` refuses to run when `web/dist` is missing or empty, because
that failure is otherwise silent: the Worker deploys, the API answers, and every
other route 404s.

Add `--dry-run` to bundle without writing anything.

## 4. Run a node

```bash
CELLD_VARS_FILE=$PWD/celld-vars.env \
CELLD_IDLE_EVICT_S=300 \
celld --bucket s3://celld-fleet --endpoint http://127.0.0.1:9100 --listen 127.0.0.1:8080
```

See [Operating](#operating) for what `CELLD_IDLE_EVICT_S` buys you.

## 4b. Apply the registry migrations

```bash
celld d1 migrations apply nadi-registry \
  --bucket s3://celld-fleet --endpoint http://127.0.0.1:9100
```

**This comes after the node is running, not before.** A celld D1 database is a
cell, so `celld d1` needs a live fleet to talk to: it finds a node through the
node leases in the bucket, and that node routes the work to the database's
owner. Running it against a stopped fleet fails with nothing to reach.

It reads the same `migrations/` directory `drizzle-kit generate` writes for
Cloudflare — there is no separate celld schema or migration history — and
records what it applied in `d1_migrations`, exactly as `wrangler d1 migrations`
does. Re-run it after every schema change; it is idempotent.

> **Expect the first attempt after a node restart to fail, and retry it.** In a
> deploy this step runs seconds behind `docker compose restart celld`, which is
> exactly when the previous node session's lease on the registry cell is still
> stale. The losing attempt is loud and looks fatal:
>
> ```
> Error: decode the database reply (503 Service Unavailable): cell Worker failed:
> ... peer no longer owns __D1Database:<hash>
> ```
>
> A run before the node is up gives the same race from the other side, as
> `409 Conflict: peer request targets a different node session`. Both clear
> within a few seconds. Measured on a laptop stack and on a hosted node, so
> automate the retry rather than treating a single failure as a bad deploy —
> and because the command is idempotent, retrying costs nothing.

## 5. First sign-in

Nadi is **invite-only**. The first account must be listed in
`SUPERUSER_EMAILS`, or the request is accepted and quietly added to a waiting
list instead.

```bash
curl -X POST -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","type":"sign-in"}' \
  http://127.0.0.1:8080/api/auth/email-otp/send-verification-otp
```

With Resend configured the code arrives by email. With
`AUTH_OTP_LOG_FALLBACK=true` it appears in the node's log. Then:

```bash
curl -X POST -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","otp":"123456"}' \
  http://127.0.0.1:8080/api/auth/sign-in/email-otp
```

Signing in provisions your workspace and a default agent.

## Trying it without a bucket: `celld dev`

Steps 1–5 need an S3-compatible bucket. `celld dev` does not: it runs one node
against a local SQLite object store, keeps state in `.celld/dev`, and rebuilds
the app when a source or configuration file changes.

```bash
pnpm web:build                                   # celld serves the SPA
CELLD_VARS_FILE=$PWD/deploy/celld/celld-vars.env pnpm celld:dev
```

The Worker lands on `http://127.0.0.1:9876` (`--port` to move it). A failed
build leaves the previous version serving rather than taking the node down, and
a successful rebuild keeps the durable state.

This is the fastest way to answer "does this actually run on celld", which
before v0.4.0 meant bringing up Docker and MinIO — so it was usually not asked
until something had already broken in the packaged stack. `.celld/` is
gitignored; delete it to start from nothing.

It is a development tool, not a deployment: a regular node cannot select the
local object store, so nothing here transfers to a server.

## Running on a server

Steps 1–5 bring the API up on localhost. A real server adds three requirements
that localhost hides. (Serving the web UI used to be a fourth: through v0.3.0
`wrangler.celld.jsonc` had no `assets` binding, `celld deploy` uploaded only the
Worker, and something else had to serve `web/dist`. celld serves it now, so the
proxy below exists for TLS alone.)

**TLS is required, not recommended.** `resolveArtifactOrigin` hardcodes
`https://` for any non-localhost artifact host, so artifact previews break over
plain HTTP. Better Auth also derives its cookie settings from `APP_BASE_URL`;
an `http://` value there yields cookies that never stick, which presents as
"sign-in succeeds, then I am immediately signed out".

**Two hostnames, not one.** Published artifacts are served from their own
origin so untrusted HTML never shares an origin with the app's cookies.
`ARTIFACTS_HOST` is matched against the request hostname, so it must be a real
DNS name pointing at the same machine.

**`S3_ENDPOINT` must be reachable by the browser.** Attachment and feedback
downloads answer with a 302 to a presigned S3 URL built from it. An
endpoint that only resolves inside your network — a Docker service name, a
private address — produces links only the server can open, and attachments
fail for everyone while every other feature looks fine.

### The packaged setup

[`deploy/celld/`](../deploy/celld/README.md) has a Dockerfile and Compose file
covering all three: Caddy terminates TLS for both hostnames, and celld runs
behind it with no published port, serving both the Worker and the SPA. Its
README is the operating reference for the packaged stack, in both the
single-node and multi-node topologies.

```bash
cd deploy/celld
cp .env.example .env                          # hostnames, bucket, S3 credentials
cp celld-vars.env.example celld-vars.env      # app config and secrets
```

Point both hostnames at the machine first — Caddy issues certificates on
startup and cannot if DNS does not resolve yet.

**`wrangler.celld.jsonc` does not need editing.** It is read only by `celld
deploy`, which bakes its `vars` into the uploaded bundle; the node takes no
`--config` at all. `CELLD_VARS_FILE` is documented by celld as *"Worker
variable overrides"* and does exactly that, so `APP_BASE_URL`,
`SUPERUSER_EMAILS` and the rest belong in `celld-vars.env` — which is
gitignored, so per-deployment values and personal email addresses never enter
a tracked file. (Verified: with `FEEDBACK_ADMIN_EMAILS` set only in the vars
file, `/api/bootstrap` reports `features.feedbackAdmin: true` against a bundle
built with the committed default.)

### Running the packaged setup locally

The stack also runs with no domain, no certificates and no open ports, which is
the fastest way to try it. Set the three site addresses to `.localhost` names
with an explicit `http://` scheme:

```bash
NADI_SITE=http://app.localhost
ARTIFACTS_SITE=http://artifacts.localhost
S3_SITE=http://s3.localhost
S3_HOSTNAME=s3.localhost
```

Two details make this work, and neither generalises to other local hostnames:

- The `http://` prefix turns Caddy's auto-HTTPS **off**. A bare hostname turns
  it on and Caddy tries to issue a certificate it cannot get.
- `.localhost` is required, not cosmetic. `resolveArtifactOrigin` mints
  `http://` origins only for `localhost` and `*.localhost` hosts and `https://`
  for everything else, so `nadi.test` or `nadi.local` would produce artifact
  URLs on an origin nothing serves. Better Auth's cookies rely on the same
  property. macOS and the major browsers resolve `*.localhost` to `127.0.0.1`
  natively, so no `/etc/hosts` entry is needed.

`S3_HOSTNAME` is attached to the Caddy container as a Docker network alias.
That is what lets `S3_ENDPOINT` be a **single** value that resolves from both
sides — the browser via loopback, the Worker via Docker DNS. It has to be a
single value: the Worker signs its own uploads against `S3_ENDPOINT` *and*
presigns browser download URLs from it, and SigV4 signs the `Host` header, so
two hostnames means one of the two fails its signature check.

```bash
docker compose --profile minio up -d     # only if you want the bundled S3
docker compose run --rm deploy           # bundle + upload the Worker
docker compose up -d                     # celld + Caddy
docker compose run --rm migrate          # apply migrations/ to the registry
```

The migrate step is last because the registry database is a cell and `celld d1`
needs a live node to reach it. Re-run it after any schema change.

Sign in as in step 5, against your real hostname.

### Deploying a change

Both images bake the repo in with `COPY . .`, so **rebuild before deploying** —
`docker compose run --rm deploy` reuses a cached image and will happily upload
the source as it was when that image was last built:

```bash
docker compose build deploy      # Worker (src/) AND SPA (web/) — one image now
docker compose run --rm deploy
```

That is the whole deploy. **No restart.** A v0.4.0 node reads the deployment
pointer every 30 seconds (`CELLD_DEPLOY_POLL_S`) and adopts a new deployment in
place: it builds the new one beside the one it is serving and switches new
requests over in a single step, while requests already running finish on the
old one. To skip the wait, `POST /reload` on the internal listener:

```bash
docker compose exec celld curl -fsS -X POST http://127.0.0.1:8081/reload
```

`/reload` rebuilds even an unchanged deployment, so it is also how an edit to
`celld-vars.env` takes effect without a restart.

Skipping the build does not fail. It prints `Uploaded nadi` and a
`Current Version ID` exactly as a real deploy does, then the node adopts the old
code and the change appears simply not to work. **The Version ID is the tell**:
it is a content hash, so an unchanged one after a real source change means
nothing was rebuilt. A suspiciously fast `Bundled nadi (0.6s)` against the usual
~35s says the same thing.

A `web/`-only change is no longer a Caddy rebuild. celld serves the SPA from its
`assets` binding, so the SPA ships in the same deployment as the Worker and
takes the same two commands above. The running service worker picks it up and
shows "Updated to the latest version".

**What adoption does to a running object.** A Durable Object that is not
resident simply starts on the new code. A resident one moves at a safe point —
no request running in it, no alarm running, no output waiting on durability, no
regular WebSocket open. One that reaches no safe point within
`CELLD_DEPLOY_MAX_AGE_S` (60s) is forced: celld cancels its work and closes its
sockets with code 1012, which is what a Cloudflare deploy does to every object.
The SPA reconnects on its own.

> **Two versions run at once during an adoption, and they call each other.** A
> request on the old deployment can hit a Durable Object already running the new
> one. So a change to a DO's RPC signature or its stored shape has to be
> backward-compatible for one deploy — add the new field, ship, then read it —
> exactly as it would on Cloudflare. This is the seam that produced the
> Workbenches wire-contract regressions, and it is now a deploy-time seam rather
> than a rollout-only one.

### Stopping

**`docker compose stop` is now a real drain.** celld v0.4.0 shuts down
gracefully on SIGTERM — the signal `docker stop` sends. It reports itself
unhealthy on `/.well-known/celld/health` so a load balancer stops routing to it,
answers new public requests with 503, finishes the requests it already accepted,
and then runs its local durability shutdown. Through v0.3.0 this was unverified
and `drain-stop.sh` deliberately assumed nothing.

**The grace period is what makes that true, and it is easy to get wrong.** The
budget is `CELLD_DRAIN_TOKEN_WAIT_MS` plus `CELLD_SHUTDOWN_TOTAL_MS` (40s
default). A shorter orchestrator grace SIGKILLs the node mid-shutdown, which is
the one thing the shutdown exists to prevent. `docker-compose.yaml` sets
`stop_grace_period: 90s` and pins the token wait to 0 — there is no other donor
to queue behind on one node — while `docker-compose.multinode.yaml` uses 120s
and leaves the token wait at its default, because there the token is doing real
work.

`./drain-stop.sh` is still there and still correct: it cuts traffic first and
waits for cells to go quiet before stopping anything, which is belt and braces
over a drain that now happens anyway. Use it if you want certainty; plain
`docker compose stop` is no longer the reckless option it was.

What `down` **cannot** destroy is the bucket: every piece of persistent state
is a bind mount under `deploy/celld/data/`, not a named volume, so even
`docker compose down -v` leaves it intact. Verified end to end — sign in,
`./drain-stop.sh`, `docker compose down -v`, bring the stack back up, and the
same user, workspace and agent are still there, with cron resuming on its own.

That is a backstop for the volume, not for the eviction rule above. A node
killed outright — SIGKILL, a power cut, a grace period too short for the
budget above — still discards whatever has not replicated yet, which is why the
grace period matters more than the script now does.

## Operating

These are not tips. A deployment that ignores them loses data or silently stops
working.

**One node — but this is now a real decision rather than a default.** Through
v0.2.1 a second node bought availability and cost durability: failover handed a
dead node's cells to a peer that restored them from the bucket, losing anything
not yet replicated. celld v0.3.0's replicated write-behind log inverts that for
fleets of two or more — a write is acknowledged after **peer fsync**, with the
bucket upload trailing — which upstream measures at 10x lower write latency and
over 100x fewer S3 Class A operations.

So the honest position is: single node remains the *tested* posture here and
what the rest of this page assumes, and the argument against a second node is
now operational complexity rather than durability. If you want the availability,
[`deploy/celld/README.md`](../deploy/celld/README.md) is the starting point.
Neither the write-behind log nor failover has been measured on this deployment.

**`CELLD_IDLE_EVICT_S` = 300.** This decides how long a quiet cell stays
resident, and the default is deliberately high.

The old guidance here was 31–40 s, for two reasons that were true on celld
v0.1.0 and are not since v0.2.0. Replication happened *only* on idle eviction, so
a low threshold bounded what a crash cost; and anything past the scheduler's
60-second tick meant the registry never idled and therefore never replicated at
all. Measured against v0.2.0: the bucket carries **one LTX frame per
transaction**, and an unquiesced `SIGKILL` with the container destroyed 0.1 s
after the last write lost **0 of 25** registry rows.

The second reason is gone outright as of v0.3.0: cron is celld's own, not a
resident alarm cell of Nadi's, so nothing in the scheduler pins a cell any more.

What the high value buys is warmth, and the cost of getting it wrong is
concrete. When a thread's cell is evicted between messages, the next message
pays for it three times over: the transcript is restored from the bucket before
the turn can start (805 KB across 22 objects on a young thread, and it grows
with the thread), the MCP servers are re-connected and re-discovered, and any
hibernatable WebSocket goes with the cell.

The client half of that last one is worth knowing about, because it looked for
a while like a hung turn. A foreground watchdog in the SPA
(`web/src/lib/use-connection-recovery.ts`) reconnects a socket that dies while
the tab is visible — but a reconnect alone resyncs nothing: the server
broadcasts a finished turn to the sockets that were live at the time and never
re-pushes history to a reconnecting one. So the tab ended up holding a healthy
socket and stale content, with the turn already complete on the server. The
watchdog now refetches history on the CLOSED-to-OPEN transition, which closes
it. If you see a turn that never renders and then appears in full on reload,
that is the shape to look for; the node log shows it as `dropped a frame for a
closed WebSocket` next to a successful `command_completion`.

**Treat 300 as a choice rather than a proof.** The measurements above are one
pass against a local MinIO, and the durability defect that motivated the old
low value is still open upstream; the assumption baked in here is that it gets
fixed. If you would rather not make that bet, lower it — but stay above 31, for
the heartbeat reason below.

The lower bound is not about durability but about a heartbeat. The SPA posts
presence every 30 s (`setInterval(sendPresence, 30_000)`, `web/src/App.tsx`), so
**any value below 30 makes every open tab cold-start the `UserHub` cell forever**
— too slow to keep it warm, fast enough to keep dragging it back. Measured at
15 s, `UserHub` cold-started every 30.0 s to the millisecond, ~190 ms each time.
Crossing above the heartbeat costs nothing for that cell, because `UserHub`
stores nothing of its own (`src/agent/user-hub.ts` — live sockets only, presence
on `serializeAttachment`). It does widen the loss window for the cells that do
hold state.

**Quiesce before restarting.** Stop traffic, wait past the eviction threshold,
then restart. A quiesced restart loses nothing. An unquiesced one reverts to the
last eviction — on the same machine, with the disk intact. Since v0.4.0 a
SIGTERM does the quiescing for you, provided the grace period covers it (see
[Stopping](#stopping)).

**A deploy is no longer a restart.** Through v0.3.0 a node loaded a deployment
at startup only, and every deploy cost roughly ten seconds of `remote RPC owner
was stale` 500s while cell ownership resettled. v0.4.0 nodes adopt a new
deployment in place — see
[Deploying a change](#deploying-a-change). Changing the vars file is likewise a
`POST /reload` rather than a restart.

**One worker per fleet bucket.** The bucket records a single current deployment;
deploying a second worker into it displaces the first for every request.

**Scheduled work needs no arming, and no watchdog.** Automata, thread
auto-archiving and search-index repair run from `scheduled()` on celld's own
cron triggers, from the same expressions `wrangler.jsonc` uses. celld runs a
handler once per occurrence across the whole fleet, never two at a time for one
script, retries a handler that throws with increasing delay, and after downtime
runs **one** missed occurrence rather than replaying the backlog. A handler can
run late but never early.

Through v0.2.1 none of that existed — celld rejected the `triggers` key — so
Nadi drove the same jobs from a per-minute alarm DO that had to be armed by a
request, kept alive by a watchdog, and prevented from pinning its own cell with
`CELLD_ALARM_RESIDENT_MS=1000`. **All three are gone.** If you are upgrading,
delete the watchdog cron and the `CELLD_ALARM_RESIDENT_MS` setting; leaving them
costs a pointless request a minute and an eviction threshold you did not choose.

With `DEBUG_TOKEN` set you can still confirm cron is firing:

```bash
curl -H "x-debug-token: $DEBUG_TOKEN" http://127.0.0.1:8080/api/debug/celld-ticker
# {"ticker":"celld-cron","crons":{…},"lastTickMs":…,"lastDailyRunMs":…}
```

`scheduled()` stamps those markers into the secrets KV namespace under a
`system/` prefix. Both are the cron
**occurrence**, not the moment the handler ran — celld runs late but never
early — so a `lastTickMs` more than a couple of minutes behind now means
occurrences are being missed, not merely delayed.

## Upgrading celld

Nadi pins **v0.4.0** (`CELLD_VERSION` in `deploy/celld/Dockerfile`).

### v0.3.0 → v0.4.0

**This upgrade must NOT be a rolling update.** Stop every v0.3.0 node, then
start the v0.4.0 nodes. v0.4.0 moves proxied fetch, RPC and WebSocket calls onto
one versioned peer tunnel that refuses a different version, and it writes
epoch-qualified references for large KV values that a v0.3.0 node cannot read —
so a mixed fleet can make a committed value **unavailable**, not merely slow.
This is the exception to the rolling procedure in
[`deploy/celld/README.md`](../deploy/celld/README.md); on the single-node stack
it is the ordinary `./drain-stop.sh` → `docker compose build` →
`docker compose up -d`.

Like v0.3.0 before it, this release retired workarounds in this repo, so it is a
code change rather than only a version bump.

**Workspace secrets moved to a real KV binding.** celld v0.4.0 implements
Workers KV: a namespace is a cell of its own, with one writer and the same
durability as the registry. `RegistryKV` — the facade that presented a
`KVNamespace` over a `celld_kv` table in the registry D1 — is deleted, along
with the table, and both platforms now bind `SECRETS_KV`. Migration `0061` drops
`celld_kv` on both.

> **If you ran a v0.3.0 deployment with real secrets in it, copy them across
> before upgrading.** The rows are AES-GCM ciphertext under the same keys, so a
> copy is a copy — but nothing does it for you, and after migration `0061` the
> source table is gone. Read the old table with
> `celld d1 execute nadi-registry --command "SELECT key, value FROM celld_kv"`
> while still on v0.3.0, and write each pair back with
> `celld kv put SECRETS_KV <key> <value>` once on v0.4.0.

**celld serves the SPA.** `wrangler.celld.jsonc` carries an `assets` block, so
the static shell deploys with the Worker and Caddy no longer owns the split
between them. If you have a customised `Caddyfile`, drop its `@worker` matcher
and `root`/`file_server` handling and proxy everything — and note that
`docker compose build caddy` is no longer how a `web/` change ships. Cache
headers moved to `web/public/_headers`, which both platforms honour.

**Deploys stopped being restarts** — see
[Deploying a change](#deploying-a-change) — and **SIGTERM now drains**, which
changes what `stop_grace_period` has to be. See [Stopping](#stopping).

**The health endpoint moved** from `/__celld/health` to
`/.well-known/celld/health`. Update any external load-balancer or uptime check;
the compose files here already use the new path.

**What did NOT change, despite the release notes.** v0.4.0's compatibility page
stops listing RSASSA-PKCS1-v1_5 signing as a gap, which reads as though the
in-repo RS256 signer could go. It cannot: a v0.4.0 node still throws
`NotSupportedError: unsupported sign algorithm: RSASSA-PKCS1-V1_5` on the sign,
having accepted the key import. Measured, not inferred. `Response.redirect` and
`Response.error` *are* implemented now, so the shim that provided them is
deleted.

### v0.2.x → v0.3.0

This release retired three workarounds in this repo, so the upgrade is a code
change and not only a version bump — an older Nadi will not run correctly on
v0.3.0's configuration, and this Nadi will not run on v0.2.x at all.

**Native cron replaced the ticker DO.** `wrangler.celld.jsonc` now carries
`triggers.crons` and `scheduled()` runs on both platforms. The `CelldTicker`
class, the watchdog service and `CELLD_ALARM_RESIDENT_MS` are gone — see
[Operating](#operating).

> **Delete the orphaned `CelldTicker` cell, and restart the node after you do.**
> The cell left behind in the fleet bucket is not inert: it carries a persisted
> alarm, and celld keeps trying to run it against a class the Worker no longer
> exports. Measured on this deployment, it retried **~16 times a second,
> indefinitely** — 9,700 failed starts in ten minutes, each one re-reading the
> cell's 117 objects (~29 KB) from the bucket. Compaction bounds the disk, so
> nothing grows and nothing breaks; what it costs is a permanent ~1,900
> object-GETs/second against your store, which on R2 or S3 is a real bill.
>
> The log line is unmissable once you look:
>
> ```
> celld runtime start failed for CelldTicker:<hash>: no Worker exports Durable
> Object class CelldTicker
> ```
>
> ```bash
> mc rm --recursive --force "local/<fleet-bucket>/cells/CelldTicker:<hash>/"
> docker compose restart celld
> ```
>
> The restart is not optional. A running node has already restored the alarm
> into memory, so deleting the objects alone only slows the retry to once a
> minute — and the cell's `own.json` is rewritten on every attempt, so it looks
> like the delete did not take.

**Native D1 replaced the registry Durable Object.** The registry is now a real
`d1_databases` binding. A celld D1 database is a cell, so it keeps the same
fencing, replication and durable write acknowledgement it had as a DO; what
changes is that celld and Cloudflare now run the *same* code path, and the
`RegistryD1` facade, the hand-rolled batch runner and the boot-time migration
bundle are deleted. Schema is applied with `celld d1 migrations apply` from the
same `migrations/` drizzle-kit generates for Cloudflare.

> **The registry does not migrate itself across this change.** The old registry
> lived inside a Durable Object and the new one is a different cell; there is no
> supported export path between them. A deployment upgrading from v0.2.x starts
> with an empty registry — sign-in, workspace, agents and thread index are all
> recreated from scratch. Thread *transcripts* live in their own DO cells and are
> not affected, but nothing will point at them. Back up your fleet bucket first.

**Bare Node builtins bundle without a shim** (denoland/celld#157), so
`scripts/celld-esbuild.mjs` is gone. `pnpm celld:deploy` still names an esbuild
binary in `CELLD_ESBUILD` because celld wants one on `PATH` and this repo keeps
it in the pnpm store.

**`setInterval` works** (denoland/celld#156). It threw when called on every
earlier release. Note celld's rule that a Worker must clear an interval before
the handler ends, because a live interval keeps the request alive — which
`src/agent/subagent.ts` already does.

**Subagents still do not run on celld, for an unrelated reason.** The liveness
stamp that `setInterval` unblocked is never reached: the `agents` SDK builds a
subagent out of Durable Object *facets*, and celld does not implement them.
Setting `BACKGROUND_WORK_ENABLED=true` and spawning one fails immediately with

```
subAgent() is not supported in this runtime — `ctx.facets` / `ctx.exports` are
unavailable. Update to the latest `compatibility_date` in your wrangler.jsonc.
```

The advice in that message does not apply here — `wrangler.celld.jsonc` already
carries the same `compatibility_date` as `wrangler.jsonc`. It is a missing
runtime capability, not a stale config. Leave `BACKGROUND_WORK_ENABLED=false`
on celld.

**The replication corruption is fixed upstream** (#150, #158). See the
durability section.

**Watch for the isolate heap limit.** Each isolate gets a V8 heap limit,
defaulting to 128 MB to match Cloudflare, tunable with `CELLD_V8_HEAP_LIMIT_MB`.
Unlike workerd, celld *refuses* work near it rather than discarding the isolate:
`state.acceptWebSocket()` throws above 90%, and a large `toArray()` throws
naming the heap. Both lift when the heap drains. A thread cell holding a big
transcript and a hibernatable WebSocket is exactly the shape that meets this, so
it is the first thing to check behind an unexplained refused connection.

### What v0.2.1 changed (crossed on the way here)

- **X-Forwarded-* are ignored by default.** `--trust-forwarded-headers` opts
  back in and is only sound behind a proxy that *replaces* both headers; the
  packaged Caddyfile sets them explicitly for that reason.
- **A startup conditional-write probe** refuses to serve if the bucket accepts a
  write it should reject. `CELLD_STORAGE_PROBE=0` skips it — the first thing to
  try if a node will not start against a non-MinIO store.
- **Cell scopes are validated**: non-empty, ≤512 bytes, ASCII alphanumerics plus
  `_ - . : $`. Nadi's names (`workspace:<uuid>`, thread and user ids) are inside
  that, but a name is now a hard reject rather than something celld slugs.
- Fixes for a shedding bug that could leave a node refusing every request until
  restarted, an alarm lost when rescheduled within the same minute, and a
  cancelled WebSocket read desynchronising a stream.

### v0.1.0 → v0.2.0, kept for the record

**The listener flags changed, and a v0.1.0 command line does not start.** A
non-loopback `--listen` requires `--internal-listen`; `--advertise` names that
internal address and is peers-only. The upgrade must not be rolling — stop every
old node, then start the new ones.

**Two crypto capabilities moved half-way, which is worse than not moving.**
v0.2.0 announced ECDH derivation and PKCS#8 import, but `importKey("pkcs8", …,
RSASSA-PKCS1-v1_5)` succeeded while `sign` still threw. Nadi's RS256 probe used
to stop at the import, so it reported native RSA, took the native path, and threw
on every GitHub App JWT. The probe now signs (`nativeRsaAvailable`,
`src/github/jwt.ts`). **If you touch either probe, probe the operation that has
to work, not a proxy for it.**

**The first request to a cell after a restart can fail once** —
`RestoreFailed … database disk image is malformed`, which then re-restores and
serves normally on retry. It clears itself, but it is a hard error to the
caller, so a client with no retry sees a 500.

## Backups

The fleet bucket is the durable copy of everything: the registry, every thread's
history, and workspace secrets (encrypted). Back it up like any other bucket —
versioning or a periodic sync of `s3://celld-fleet` is enough. Attachments live
in the attachments bucket; back that up too.

Restoring means pointing a node at a restored bucket. Remember that anything
written after the last eviction of a given cell was never in the bucket to begin
with.

## Troubleshooting

**The bundle fails to resolve a bare `node:` builtin** — you are on celld
v0.2.x, which did not alias them. Upgrade to v0.3.0 (denoland/celld#157), which
accepts bare builtin specifiers; the `scripts/celld-esbuild.mjs` shim that used
to rewrite them is gone.

**Sign-in returns 200 but no code arrives** — no email provider is configured.
Set `RESEND_API_KEY`, or `AUTH_OTP_LOG_FALLBACK=true` for local use. The node log
says which variables are missing.

**First sign-in fails with a database error** — `DEFAULT_MODEL_PROVIDER` or
`DEFAULT_MODEL` is unset.

**Every cell starts once a minute in the node log** (`reused local hibernation
snapshot`, then `cell isolate startup completed ... fresh=false`, for the whole
fleet within a couple of seconds). Expected noise on celld today, not a symptom
of anything in Nadi. It is not the app: the minute tick reports
`automata:{fired:0,skipped:0}`, the woken cells hold no alarms of their own, and
the burst begins ~260ms BEFORE the Worker's fetch handler is even entered. It
costs isolate startups and largely defeats hibernation, but the cells wake, do
nothing, and hibernate again at the same epoch. Root cause is unresolved and
sits inside celld's `ltx_repl` restore path.

**`remote RPC owner was stale` right after a restart** — expected for about ten
seconds while ownership settles; see "Deploying a change".

**Sending a message fails with `cloudflare_config_missing`** —
`DEFAULT_SANDBOX_PROVIDER` is unset, so the workspace was provisioned with the
Cloudflare provider, which cannot exist on celld. Set the var *and* switch the
existing workspace in Settings → Sandbox: the var only affects new workspaces,
because the provider is persisted per workspace at sign-up.

**A code change appears to do nothing after deploying** — the `deploy` image was
not rebuilt, so it uploaded the source baked into the cached image. Check the
`Current Version ID`: it is a content hash, so an unchanged one after a real
source change means nothing was rebuilt. See "Deploying a change".

**Everything behaves as though configuration is missing** — the vars file is
probably JSON. It must be `KEY=VALUE` lines.

**`cron schedule not armed` in the log right after a restart** — expected, and
it clears itself. While the previous node session's lease on the `.cron:nadi`
cell is still stale, arming races it:

```
WARN  celld: peer owner unreachable scope=.cron:nadi owner=127.0.0.1:8081
WARN  celld: cron arm failed, retrying cell=".cron:nadi"
ERROR celld: cron schedule not armed cell=".cron:nadi"
```

It reads like a hard failure of exactly the thing the ticker used to guard, so
it is worth knowing it is not one. Measured here: a restart at 23:32 logged the
ERROR above and ticks resumed at 23:32, 23:34, then every minute — one or two
missed occurrences across the restart window, then normal. Only a `lastTickMs`
that stays behind for several minutes is a real stall.

**Automata never fire** — check `/api/debug/celld-ticker`. A `lastTickMs` of
`null` means `scheduled()` has never run: confirm `triggers.crons` survived into
the deployment you actually shipped (a stale `Current Version ID` after a deploy
means nothing was rebuilt). A `lastTickMs` that is stale rather than null means
occurrences are being missed, not that cron is unconfigured.

**A route 404s that should exist** — `/api/debug/*` requires `DEBUG_TOKEN` to be
set *and* the matching `x-debug-token` header.

**The node exits immediately with `a non-loopback --listen or CELLD_ADDR
requires an explicit --internal-listen or CELLD_INTERNAL_ADDR`** — since
v0.2.0 celld serves the Worker's routes on `--listen` and everything else
(peer traffic, and the operator API `/state` + `/shutdown`) on a second
listener, and it will not reuse the public one for both. The Compose file
passes `--internal-listen 127.0.0.1:8081` for this: with a single node there
are no peers, so the internal listener stays on loopback inside the container
where nothing can reach the unauthenticated operator routes. Running celld by
hand on `0.0.0.0` needs the same flag; the localhost form in step 4 does not,
because `127.0.0.1` is not an unspecified address.

On v0.1.0 this same situation demanded `--advertise` instead. That flag now
names the *internal* address and is only needed with peers.

**Caddy exits on startup with an `email` or site-address parse error** — a
`*_SITE` variable is empty. All three (`NADI_SITE`, `ARTIFACTS_SITE`,
`S3_SITE`) plus `ACME_EMAIL` must be non-empty, even when auto-HTTPS is off.
