---
name: first-deploy
description: Provision Cloudflare resources and deploy this app to a fresh account for the first time. Use when someone has cloned the repo and wants their own instance running — e.g. "deploy this to my Cloudflare account", "set up nadi for me", "I cloned this, how do I run it in production", "first deploy", "self-host this".
---

# First deploy to your own Cloudflare account

Takes a fresh clone to a running deployment. Everything here is done **once**;
afterwards `pnpm run deploy` is the whole workflow.

The repo ships no account-specific values. `wrangler.jsonc` is for local dev and
already works as-is — never edit it. Production config lives in
`wrangler.prod.jsonc`, which is **gitignored**: you create it from the committed
template, so `git status` stays clean and pulls never conflict.

## Before starting

Confirm with the user, and stop if any are missing:

- A Cloudflare account **on the Workers Paid plan** — Durable Objects with SQLite
  storage and Containers both require it. The free plan cannot run this app.
- `wrangler` authenticated: `pnpm exec wrangler whoami`. If not, they run
  `wrangler login` themselves (it is interactive and opens a browser).
- A domain on that Cloudflare account, if they want a custom hostname. Optional —
  `workers.dev` works for a first deploy.

If the account has more than one Cloudflare account attached, note the account id
now; several commands below need `CLOUDFLARE_ACCOUNT_ID` set or they abort with
"More than one account available".

## 1. Provision the resources

Run these and **keep each id that comes back**:

```bash
pnpm exec wrangler d1 create nadi-registry          # → database_id
pnpm exec wrangler kv namespace create SECRETS_KV   # → id
pnpm exec wrangler r2 bucket create nadi-attachments
pnpm exec wrangler r2 bucket create nadi-compute-backups
```

Bucket names are referenced by name and need no id. If a name is taken, pick
another and change it in the config in step 2 — the names are not load-bearing.

## 2. Write `wrangler.prod.jsonc`

```bash
cp wrangler.prod.example.jsonc wrangler.prod.jsonc
```

Replace every `<PLACEHOLDER>`:

| Placeholder | Value |
| --- | --- |
| `<YOUR_CLOUDFLARE_ACCOUNT_ID>` | from `pnpm exec wrangler whoami` |
| `<YOUR_D1_DATABASE_ID>` | from step 1 |
| `<YOUR_KV_NAMESPACE_ID>` | from step 1 |
| `<your-domain.example>` | your hostname |

Without a custom domain: delete the `routes` array and set `CANONICAL_HOST` to
`""`. `workers_dev: true` still gives you a `*.workers.dev` URL. Leave
`LEGACY_HOSTS` empty — it only matters once you have moved between hostnames.

Then check you have not drifted from the app's bindings:

```bash
pnpm run check:wrangler
```

## 3. Secrets

Required — the app will not start without these three:

```bash
openssl rand -base64 32 | pnpm exec wrangler secret put BETTER_AUTH_SECRET --config wrangler.prod.jsonc
openssl rand -base64 32 | pnpm exec wrangler secret put TOOL_APPROVAL_SECRET --config wrangler.prod.jsonc
openssl rand -base64 32 | pnpm exec wrangler secret put SECRETS_STORE_KEK_RAW_B64 --config wrangler.prod.jsonc
```

**`SECRETS_STORE_KEK_RAW_B64` encrypts every stored provider key.** Rotating or
losing it makes all saved workspace secrets undecryptable. Tell the user to back
it up somewhere durable before moving on.

Optional, each unlocking one feature — skip any and that feature stays off:

- `RESEND_API_KEY` — real sign-in emails. Without it the OTP is written to a
  local file, which is fine for local dev and useless in production, so in
  practice you want this.
- `EGRESS_PROXY_TOKEN` — only if routing a provider through a clean-egress proxy
  (see `infra/egress-proxy/`).
- `DAYTONA_API_KEY` — only for the Daytona compute backend.
- `DEBUG_TOKEN` — gates `/api/debug/*`. Leave unset and those routes 404.

## 4. Migrate and deploy

```bash
pnpm run db:migrate:remote
pnpm run deploy
```

`deploy` builds the SPA and pushes the Worker. The first one is slow: it builds
and uploads the sandbox container image.

**Docker must be running** for the container build. If it is not available, the
deploy fails at the image step — deploy from a machine with Docker, or from CI.

## 5. Verify — do not skip

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://<your-host>/
curl -s -o /dev/null -w '%{http_code}\n' https://<your-host>/api/bootstrap
```

Both must return 200. Then in a browser: sign in, send a message in a new
thread, and confirm a reply streams back. A 200 on the shell only proves assets
are served — it does not prove the Worker, D1, or the Durable Objects work.

Sign-in is invite-only by default. Set `SUPERUSER_EMAILS` in
`wrangler.prod.jsonc` to your own address before deploying, or you will not be
able to get in.

For a reply you also need a model provider: sign in, then **Settings →
Providers**, and add a key. No key means no reply, and the failure looks like a
hang rather than an error.

## Troubleshooting

- **"More than one account available"** — `export CLOUDFLARE_ACCOUNT_ID=<id>`.
- **D1 migration hits the wrong database** — a stale or wrong `database_id` in
  `wrangler.prod.jsonc`. `wrangler` trusts the id over the name.
- **Sign-in email never arrives** — no `RESEND_API_KEY`. Locally the body is
  written to `/tmp/miniflare-*/email/email-text/*.txt`; in production it goes
  nowhere.
- **Container/sandbox errors on deploy** — Docker is not running, or the account
  is not on Workers Paid.
