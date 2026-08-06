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
| GitHub App auth (private repo clone/push) | celld's WebCrypto has no RSA |

Nadi hides the first two rather than offering something that fails on use.

**Web push works**, though celld has no ECDH: the payload encryption is
implemented in-repo against `@noble/curves`, selected by probing whether native
ECDH is available rather than by platform, and verified byte-identical to the
Cloudflare path. VAPID keys in either common format work — a raw 32-byte scalar
(what `web-push generate-vapid-keys` emits) or PKCS#8.

## Durability: read this before you rely on it

celld replicates a cell to your bucket **only when that cell goes idle**. An
unquiesced crash therefore loses everything written since the affected cell last
went quiet — and it does so *even if the machine survives*, because celld
restores from the bucket at startup and discards local-only state.

This is an accepted trade for a single-user deployment, bounded by the rules in
[Operating](#operating). It is not a bug you can configure away, and it is why
the recommended posture is one node with a low idle-eviction threshold.

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

## Operating

These are not tips. A deployment that ignores them loses data or silently stops
working.

**One node.** The durability posture above is only sound with a single node.
Adding a second introduces failover, where a node that dies hands its cells to a
peer that restores them from the bucket — losing everything since those cells
last went idle. Do not scale out without revisiting it.

**`CELLD_IDLE_EVICT_S` = 15–30 s.** This is the only thing bounding what a crash
costs, because it decides how soon a quiet cell replicates. It must also stay
well below the scheduler's 60-second tick: at 15 s, each cycle leaves a ~45 s
quiet window in which the registry replicates. Raise it past ~60 s and the
registry never idles, never replicates, and a crash loses everything back to the
last restart.

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

**Everything behaves as though configuration is missing** — the vars file is
probably JSON. It must be `KEY=VALUE` lines.

**Automata never fire** — either the deployment has never been requested (the
first request arms the ticker), or `CELLD_ALARM_RESIDENT_MS` is unset, in which
case the ticker never replicates and does not survive restarts. Check
`/api/debug/celld-ticker`.

**A route 404s that should exist** — `/api/debug/*` requires `DEBUG_TOKEN` to be
set *and* the matching `x-debug-token` header.
