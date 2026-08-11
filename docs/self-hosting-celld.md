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

Nadi hides these rather than offering something that fails on use — voice and
Workers AI via `platformCapabilities`, and the Cloudflare sandbox via
`containerSandbox`, which the settings PUT enforces too so a hand-rolled request
cannot select it either. **Sandboxes work** on Daytona and on sprites; pick one
in Settings → Sandbox.

**Web push works**, though celld has no ECDH: the payload encryption is
implemented in-repo against `@noble/curves`, selected by probing whether native
ECDH is available rather than by platform, and verified byte-identical to the
Cloudflare path. VAPID keys in either common format work — a raw 32-byte scalar
(what `web-push generate-vapid-keys` emits) or PKCS#8.

**GitHub App auth works**, though celld's WebCrypto has no RSA: the RS256 JWT
that private-repo clone/push needs is signed in-repo with BigInt, selected by
probing whether native `importKey("pkcs8", …, RSASSA-PKCS1-v1_5)` succeeds
rather than by platform, and verified byte-identical to the Cloudflare path in
the integration suite. Only PKCS#8 keys are accepted — if your GitHub App key
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

celld replicates a cell to your bucket **only when that cell goes idle**. An
unquiesced crash therefore loses everything written since the affected cell last
went quiet — and it does so *even if the machine survives*, because celld
restores from the bucket at startup and discards local-only state.

This is an accepted trade for a single-user deployment, bounded by the rules in
[Operating](#operating). It is not a bug you can configure away, and it is why
the recommended posture is one node with a low idle-eviction threshold.

Verified here rather than assumed: write a thread and a message, `SIGKILL` the
node seconds later, recreate the container, and both are gone. Waiting past the
eviction threshold first leaves the earlier writes intact. Preserving celld's
local working directory does **not** rescue them — a kill with the same
container restarted loses the same data, so there is no volume you can add to
avoid this.

> **A separate, worse failure: concurrent writes can corrupt the backup, and
> draining does not save you.** Under concurrent writes to one cell, celld can
> replicate a chain that is missing pages it references. That cell then fails
> every later request with `RestoreFailed` /
> `missing page N in restore plan (incomplete backup)`, permanently.
>
> The damage happens during the writes, not at shutdown. Measured: a cell driven
> by four concurrent writers, then left completely quiet for 50 s so it evicted
> and replicated, was still unrecoverable afterwards — via a hard kill **and via
> a graceful `SIGTERM` stop**. So `./drain-stop.sh` does not protect against
> this, and neither does any other shutdown discipline; only the amount of
> write concurrency matters.
>
> Reproduced on a minimal worker
> (github.com/ruqqq/celld-incomplete-backup-repro). On Nadi itself we have only
> observed the plain rollback above, never this corruption — treat them as two
> distinct problems, not one. Root-caused upstream to a capture/checkpoint race
> in celld's LTX replication; a fix is in review.

## Prerequisites

- A machine with Node 22+, `pnpm`, and `git`.
- **celld**: `curl -fsSL https://celld.dev/install.sh | sh`
- **An S3-compatible bucket.** [MinIO](https://min.io) is fine and is what this
  was tested against; so is Cloudflare R2 or AWS S3. You need two buckets, or one
  bucket and one prefix: the *fleet* bucket celld replicates into, and an
  *attachments* bucket.
- `esbuild` is resolved automatically from this repo's dependencies. Nothing to
  install.

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
- `DEBUG_TOKEN` — enables `/api/debug/*` routes, including the ticker health
  check below.

## 3. Deploy

```bash
pnpm celld:deploy -- --bucket s3://celld-fleet --endpoint http://127.0.0.1:9100
```

One command. It bundles with the alias shim celld needs (`scripts/celld-esbuild.mjs`
— without it the bundle fails outright on a transitive `require('path')`) and
uploads to the fleet bucket.

Add `--dry-run` to bundle without writing anything.

## 4. Run a node

```bash
CELLD_VARS_FILE=$PWD/celld-vars.env \
CELLD_IDLE_EVICT_S=15 \
CELLD_ALARM_RESIDENT_MS=1000 \
celld --bucket s3://celld-fleet --endpoint http://127.0.0.1:9100 --listen 127.0.0.1:8080

curl http://127.0.0.1:8080/    # first run only — arms the scheduler
```

Both `CELLD_*` settings matter; see [Operating](#operating) for what each one
buys you.

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

## Running on a server

Steps 1–5 bring the API up on localhost. A real server adds four requirements
that localhost hides, and the first is the one that surprises people:

**celld does not serve the web UI.** On Cloudflare the SPA comes from the
`assets` binding; `wrangler.celld.jsonc` has no such binding and `celld deploy`
uploads only the Worker bundle, so `src/index.ts` falls through to `route()`
and answers every non-API path with a 404. Something else has to serve
`web/dist`. This is not a gap you can configure away — it is what the reverse
proxy is for.

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
covering all four: Caddy serves `web/dist` and terminates TLS for both
hostnames, and celld runs behind it with no published port. Its README is the
operating reference for the packaged stack, in both the single-node and
multi-node topologies.

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
docker compose up -d                     # celld + Caddy + ticker watchdog
```

Sign in as in step 5, against your real hostname.

### Deploying a change

Both images bake the repo in with `COPY . .`, so **rebuild before deploying** —
`docker compose run --rm deploy` reuses a cached image and will happily upload
the source as it was when that image was last built:

```bash
docker compose build deploy      # Worker changes (src/)
docker compose run --rm deploy
./drain-stop.sh --restart        # a node loads a deployment at startup only

docker compose build caddy       # SPA changes (web/) — no redeploy needed
docker compose up -d caddy
```

Skipping the build does not fail. It prints `Uploaded nadi` and a
`Current Version ID` exactly as a real deploy does, then the restart serves the
old code and the change appears simply not to work. **The Version ID is the
tell**: it is a content hash, so an unchanged one after a real source change
means nothing was rebuilt. A suspiciously fast `Bundled nadi (0.6s)` against the
usual ~35s says the same thing.

The SPA is served by Caddy, not by celld, so a `web/`-only change needs the
`caddy` rebuild and no `deploy`/restart at all. The running service worker
picks it up and shows "Updated to the latest version".

**A deploy is not zero-downtime.** For roughly ten seconds after the node comes
back, registry RPC answers `remote RPC owner was stale` while cell ownership
settles. Signed-in requests fail with a 500 in that window — Better Auth cannot
read its session table — and the ticker logs `celld_ticker.arm_failed`. It
clears on its own and needs no intervention, but anyone using the app during a
deploy sees errors rather than a retry. Deploy when nobody is mid-turn.

### Stopping

**Use `./drain-stop.sh`, not `docker compose down`.** celld replicates a cell
only when that cell goes idle, so stopping the node while traffic is live
discards everything written since the last eviction — on a healthy machine,
with the disk intact. The script cuts traffic, waits past the eviction
threshold, and only then stops the node.

`stop_grace_period` is set to 60s as a backstop, but whether celld quiesces on
SIGTERM is unverified. Do not rely on it.

What `down` **cannot** destroy is the bucket: every piece of persistent state
is a bind mount under `deploy/celld/data/`, not a named volume, so even
`docker compose down -v` leaves it intact. Verified end to end — sign in,
`./drain-stop.sh`, `docker compose down -v`, bring the stack back up, and the
same user, workspace and agent are still there, with the ticker resuming from
its persisted alarm.

That is a backstop for the volume, not for the eviction rule above. Stopping
the node mid-traffic still discards whatever has not replicated yet, which is
why the drain still matters.

## Operating

These are not tips. A deployment that ignores them loses data or silently stops
working.

**One node.** The durability posture above is only sound with a single node.
Adding a second introduces failover, where a node that dies hands its cells to a
peer that restores them from the bucket — losing everything since those cells
last went idle. Do not scale out without revisiting it.

celld itself is built for a cluster, so this is a property of *this* deployment
rather than a limit of the runtime. If you need the availability, there is an
untested starting point in [`deploy/celld/README.md`](../deploy/celld/README.md)
— read what failover costs there before deciding it is worth it.

**`CELLD_IDLE_EVICT_S` = 31–40 s.** This is the only thing bounding what a crash
costs, because it decides how soon a quiet cell replicates. It must also stay
well below the scheduler's 60-second tick: at 35 s, each cycle leaves a ~25 s
quiet window in which the registry replicates. Raise it past ~60 s and the
registry never idles, never replicates, and a crash loses everything back to the
last restart.

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
last eviction — on the same machine, with the disk intact.

**A deploy is not a rollout.** Nodes load a deployment at startup only. Restart
the node to pick up a new deploy. Changing the vars file also needs a restart,
but no redeploy.

**One worker per fleet bucket.** The bucket records a single current deployment;
deploying a second worker into it displaces the first for every request.

**`CELLD_ALARM_RESIDENT_MS` = 1000.** Automata, thread auto-archiving and
search-index repair are driven by an internal ticker that re-arms itself every
minute. celld keeps a cell resident while it has an imminent alarm — and with a
60-second tick, the ticker's alarm is *always* imminent, so by default it never
goes idle, never replicates, and its pending alarm dies with the node. Scheduled
work then silently never resumes.

Setting this to 1000 lets the ticker evict between ticks, so its alarm is
persisted and celld's waker fires it after a restart. Verified: hard-kill the
node, restart it, make no requests at all, and the ticker resumes on its own.

**Arm the scheduler on first run.** A brand-new deployment has no alarm to
restore, and the ticker is armed by the first request. One `curl` after the
first start is enough — it is not needed on subsequent restarts. A host-side
watchdog is still worth having as a backstop:

```cron
* * * * * curl -sf http://127.0.0.1:8080/ >/dev/null
```

With `DEBUG_TOKEN` set you can check the ticker directly:

```bash
curl -H "x-debug-token: $DEBUG_TOKEN" http://127.0.0.1:8080/api/debug/celld-ticker
# {"lastTickMs":…, "lastDailyRunMs":…}
```

A `lastTickMs` older than a couple of minutes means the ticker is not running.

## Backups

The fleet bucket is the durable copy of everything: the registry, every thread's
history, and workspace secrets (encrypted). Back it up like any other bucket —
versioning or a periodic sync of `s3://celld-fleet` is enough. Attachments live
in the attachments bucket; back that up too.

Restoring means pointing a node at a restored bucket. Remember that anything
written after the last eviction of a given cell was never in the bucket to begin
with.

## Troubleshooting

**The bundle fails with `Could not resolve "path"`** — you invoked `celld deploy`
directly instead of `pnpm celld:deploy`. celld's bundler does not alias bare node
builtins; the wrapper does.

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

**Automata never fire** — either the deployment has never been requested (the
first request arms the ticker), or `CELLD_ALARM_RESIDENT_MS` is unset, in which
case the ticker never replicates and does not survive restarts. Check
`/api/debug/celld-ticker`.

**A route 404s that should exist** — `/api/debug/*` requires `DEBUG_TOKEN` to be
set *and* the matching `x-debug-token` header.

**The node exits immediately with `--advertise is required when --listen uses
an unspecified address`** — celld refuses to bind `0.0.0.0` without being told
the address peers would dial, even though the recommended posture has no peers.
The Compose file passes `--advertise celld:8080` for this. Running celld by
hand on `0.0.0.0` needs the same flag; the localhost form in step 4 does not,
because `127.0.0.1` is not an unspecified address.

**Caddy exits on startup with an `email` or site-address parse error** — a
`*_SITE` variable is empty. All three (`NADI_SITE`, `ARTIFACTS_SITE`,
`S3_SITE`) plus `ACME_EMAIL` must be non-empty, even when auto-HTTPS is off.
