# Cloudflare Sandbox compute — operations runbook

Nadi's second compute provider, alongside Daytona. A workspace's threads run
their agent tools (exec, file read/write/patch) inside a Cloudflare Container,
one per thread, backed by `@cloudflare/sandbox`. This document covers
provisioning, deployment, and the live smoke checklist. It does not cover the
image recipe itself — see
[`scripts/smoke-cloudflare-sandbox-image.sh`](../../scripts/smoke-cloudflare-sandbox-image.sh),
whose header is the canonical source for how `container/Dockerfile` is built
and how to debug a broken build.

Nothing in this document has been exercised end-to-end against the real
Cloudflare API yet. Every claim below that depends on a live Worker, a live
container, or a live R2 bucket is called out as unverified in the smoke
checklist (Part 3) — that checklist, run once by a Docker-capable operator, is
what turns this from a design doc into a verified runbook.

## 1. Infrastructure provisioning

These commands provision the R2 bucket and its two SigV4 secrets. Run them
once per Cloudflare account, before any Cloudflare-backed workspace can go
ready. No secret values appear below or should ever be committed.

```bash
pnpm wrangler r2 bucket create nadi-compute-backups
pnpm wrangler r2 bucket lifecycle add nadi-compute-backups nadi-compute-expiry backups/ --expire-days 8 --force
pnpm wrangler secret put R2_ACCESS_KEY_ID
pnpm wrangler secret put R2_SECRET_ACCESS_KEY
```

- **Workers Paid is required.** Containers are not available on the free plan.
- The bucket name is already wired as the `BACKUP_BUCKET` R2 binding and the
  `BACKUP_BUCKET_NAME=nadi-compute-backups` var in `wrangler.jsonc`. Both are
  plain config, not secrets — only the two `wrangler secret put` values above
  are sensitive.
- `CLOUDFLARE_ACCOUNT_ID` is also a `wrangler.jsonc` var (not a secret); it is
  already set alongside `BACKUP_BUCKET_NAME`.
- The R2 API token backing `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` needs
  **Object Read & Write** scope on `nadi-compute-backups` (or account-wide R2
  object read/write). It does not need bucket-admin permissions — the lifecycle
  rule above is applied once via `wrangler`, not by the running Worker.

**Why the SigV4 credentials are mandatory, not optional.** `@cloudflare/sandbox`
presigns the R2 URLs it uses for `createBackup`/`restoreBackup`. The SDK can
instead resolve the `BACKUP_BUCKET` binding directly with `createBackup({...,
localBucket: true})`, which needs no SigV4 credentials — but Nadi's Cloudflare
backend always passes `useLocalBucket: false` (see `src/compute/backends/cloudflare.ts`
and the Task 4 note in `.superpowers/sdd/progress.md`: `useLocalBucket` was
collapsed to a hardcoded `false` because every supported config already
required the presign credentials, making the `true` branch unreachable).
Consequently:

- `computeProviderReadiness` (`src/compute/settings.ts`) lists
  `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` in `CLOUDFLARE_REQUIRED_CONFIG`
  and will not report the Cloudflare provider `ready` without both.
- **Local-dev Cloudflare compute is therefore unsupported.** Making
  `localBucket: true` reachable in local dev is a separate, not-yet-planned
  change (readiness would need to stop requiring the SigV4 keys, and
  `useLocalBucket` would need to become a real decision rather than a
  documented constant).

**Why the 8-day lifecycle expiry.** Nadi's own recovery bookkeeping computes an
`expiresAt` for each backup from a per-workspace `recoveryTtlMs`, clamped to at
most 604,800,000 ms (7 days / 168 hours; `src/http/sandbox-settings-routes.ts`,
`clampPositiveInt` in `src/compute/config.ts`), defaulting to 24 hours. The R2
lifecycle rule expires objects under `backups/` after 8 days — one day past the
longest TTL Nadi will ever set. It exists purely as a backstop against orphaned
backup objects (a GC bug, a crashed cleanup pass); it is not the mechanism that
enforces Nadi's TTL policy, which is application-level.

**Expect more backup objects than before.** The idle-retention probe used to read
a repo with no upstream branch as clean, so a coding thread that had committed
but not pushed was discarded at the idle timeout and wrote no backup. It now
counts commits no remote already has (`rev-list --count HEAD --not --remotes`)
and releases such a thread as `recoverable`, which writes an R2 backup that lives
out `recoveryTtlMs`. This is the intended trade — those commits were being
destroyed — but it moves cost from zero to one backup object per affected thread.
`recoveryTtlMs` is the lever. The full retention rules, including the
provider-specific part that does NOT apply to Cloudflare or Daytona, are in
`docs/architecture.md` under "Idle retention".

## 2. Deploying: three ways to run `wrangler deploy`

`wrangler.jsonc` points both containers (`NadiSandboxSmall`, `NadiSandboxMedium`)
at `./container/Dockerfile`. When a container's `image` is a Dockerfile path
(not a registry reference), **`wrangler deploy` builds that image locally with
Docker and pushes it to Cloudflare's container registry as part of the
deploy.** A machine without Docker cannot run `pnpm run deploy` at all — it
fails at the image-build step before the Worker script itself is uploaded. (CI
sidesteps this on unchanged containers by rewriting `image` to a registry
reference — see (a) below.)

Nadi's primary development box has no Docker. That's the reason
`scripts/smoke-cloudflare-sandbox-image.sh` exists as a separate build-only
gate, and the reason there are three distinct ways to actually ship a deploy
that includes this branch:

### (a) Deploy from GitHub Actions

`.github/workflows/deploy.yml` runs `pnpm run deploy` on `ubuntu-latest`. That
runner image ships Docker Client and Server (28.x) plus Buildx, and it is amd64
— matching the amd64-only base image, so no emulation. Trigger it
(`workflow_dispatch`) and pick this branch (or `main`, once merged) in the "Run
workflow" ref dropdown.

**The workflow only builds the image when the image changed.** It tags the image
with the git tree hash of `container/` — which changes if and only if the
Dockerfile or a file it copies changes — and pushes it to one shared repository
(`nadi-sandbox`; both classes build the same recipe and differ only by
`instance_type`). If that tag is already in the registry, the build and push are
skipped and the deploy pins both containers at
`registry.cloudflare.com/<account>/nadi-sandbox:<tag>` instead of the Dockerfile
path — a registry reference, so `wrangler deploy` never invokes Docker. Keeping
the reference byte-identical also means Cloudflare doesn't roll the running
container instances on an unrelated deploy.

The tree hash does not track upstream drift in the base image (the Dockerfile
pins `cloudflare/sandbox` by tag, not digest). The `force_rebuild` input rebuilds
and re-pushes under the same tag when you need to pick that up.

The workflow preflights `pnpm wrangler whoami` (and `docker info`, when it is
going to build) **before** the D1 migration step. This ordering is deliberate: a
failure in the deploy step would otherwise leave remote D1 migrated but the code
un-deployed, i.e. the schema ahead of what's running.

**Token permissions.** `CLOUDFLARE_API_TOKEN` needs, at account scope:

| Permission group | Why |
| --- | --- |
| `Workers Scripts: Edit` | Uploads the Worker. Already present. |
| `D1: Edit` | The remote migration step. Already present. |
| `Containers: Edit` | Pushes the image to Cloudflare's account-integrated registry and provisions the container config. |

`Containers: Edit` is the one to add. Caveat, stated plainly: Cloudflare's
permission reference does list `Containers Read` / `Containers Edit` as account
permission groups, but no Cloudflare doc found so far states which permission
`wrangler deploy` requires for the container push. `Containers: Edit` is
inference from the permission group's name and scope, not a quoted requirement.
There is no separate "Registry" permission group — the registry is
account-integrated and Wrangler authenticates to it automatically.

`wrangler whoami` in the preflight proves the token is *valid*; it cannot prove
it can push images. That is only exercised by the push itself. If the push 403s,
the error names what it wanted, and nothing has touched production D1 by then.

Provisioning the bucket (below) additionally needs `Workers R2 Storage: Edit`.
If an operator runs those commands from their own credentials, CI never needs
that permission.

### (b) Reference a pre-built image instead of a Dockerfile

Cloudflare Containers accept a fully-qualified Docker Hub reference
(`docker.io/<namespace>/<repository>:<tag>`) in place of a Dockerfile path.
Building and pushing the image once (from any Docker-capable machine, e.g. with
`docker push`) and then changing `wrangler.jsonc`'s `containers[].image` to
that reference means **no future deploy from any machine needs Docker at
all** — `wrangler deploy` just references the already-built image.

Tradeoff: the image is no longer rebuilt automatically from
`container/Dockerfile` on every deploy. Bumping the recipe (a tool version, a
Dockerfile line) means deliberately building and pushing a new tag, updating
`wrangler.jsonc`, and updating the version pin
`test/unit/compute/cloudflare-image.test.ts` checks — the SDK version
(`@cloudflare/sandbox` in `package.json`) and the base image tag must still
match, since the Worker client and in-container server speak a versioned
protocol.

### (c) Deploy from a Docker-capable workstation

```bash
./scripts/smoke-cloudflare-sandbox-image.sh
pnpm install
pnpm run types
pnpm run check
pnpm run deploy
pnpm wrangler containers list
```

- `./scripts/smoke-cloudflare-sandbox-image.sh` builds the image locally and
  throws it away without publishing anything — read its header before running
  it; it is the canonical troubleshooting reference for the Dockerfile.
- `pnpm run types` regenerates `worker-configuration.d.ts` and needs a complete
  `.dev.vars`. Once it lands with the Cloudflare bindings
  (`NADI_SANDBOX_SMALL`, `NADI_SANDBOX_MEDIUM`, `BACKUP_BUCKET`,
  `BACKUP_BUCKET_NAME`, `CLOUDFLARE_ACCOUNT_ID`) as non-optional, the `?` on
  those fields in `src/env.ts` can be dropped. **The runtime presence checks in
  `computeProviderReadiness` (`isComputeConfigPresent`, in
  `src/compute/settings.ts`) must stay regardless** — a binding can be typed as
  required and still be absent at runtime in a given environment, and
  readiness exists precisely to catch that case rather than trust the type.
- The first deploy uploads every container image layer and can take several
  minutes; later deploys push only changed layers.
- `pnpm wrangler containers list` confirms the containers registered with
  Cloudflare after the deploy completes.
- Cloudflare workspace selection stays disabled in the settings UI until
  `computeProviderReadiness` reports the provider ready — deploying alone does
  not turn it on if a required binding or secret is still missing.
- Use `pnpm run deploy`, not `pnpm deploy` (the latter is pnpm's own recursive
  script runner, not this repo's deploy script). `CLOUDFLARE_ACCOUNT_ID` must be
  set in the environment for `wrangler --remote` operations; in this repo it is
  already set as a `wrangler.jsonc` var, so a workstation deploy needs no
  additional export.

## 3. Real-provider smoke checklist

**Nothing on this branch has ever spoken to the real Cloudflare API.** The full
unit suite runs against a fake `Sandbox` client; not one byte has crossed the
wire to a real container, a real Durable Object, or a real R2 bucket. Every
item below is a claim the fakes (or the SDK's types) assert but cannot prove.
Run this checklist, in order, on a real deploy before trusting Cloudflare
compute in production. Record the results (template at the bottom) — never
record secret values, file contents, or paths/contents from a real user
workspace.

1. **Distinct container per thread.** Acquire compute on two different threads
   in the same workspace, once with `small` and once with `medium`. Confirm
   each thread gets a genuinely separate container (e.g. writing a file in one
   thread's workspace and confirming it is absent in the other's). The sandbox
   id is `ws_<workspaceId>_<threadId>` (`deriveSandboxId` in
   `src/compute/backends/cloudflare.ts`) — **not** derived from
   `spec.environmentId`, which for Cloudflare is always the literal constant
   `"cloudflare:small"` / `"cloudflare:medium"` regardless of thread
   (`src/agent/compute-tools.ts`). Deriving identity from `environmentId` would
   put every thread on one shared container; confirm that isn't happening.

2. **Command execution.** Run a command that produces stdout, one that exits
   non-zero, and one that reads from stdin. Confirm output, exit code, and
   stdin delivery all come back correctly.

3. **Native file operations.** Write a file, read it back, and run an
   `apply_patch`-style in-place edit through the agent's file tools. Confirm
   content round-trips exactly.

4. **`movePath` with `overwrite: true` over an existing destination.** Create a
   file at a destination path, then move another file onto it with
   `overwrite: true`. Confirm the destination now contains the *moved* file's
   contents, not the original. The backend implements this as delete-then-move
   (see the comment at `movePath` in `src/compute/backends/cloudflare.ts`)
   specifically because the container server's `/api/move` overwrite behavior
   is unknowable from the SDK — it's a thin HTTP POST to a compiled binary
   baked into the image, not code this repo can read or unit-test. This is the
   single highest-value item on this list: a silent failure here corrupts every
   in-place `apply_patch` update, and it happened once already on the Daytona
   backend.

5. **In-band failure vs. throw, across five operations.** For `restoreBackup`,
   `deleteFile`, `moveFile`/`renameFile`, `writeFile`, and `mkdir`: confirm
   whether the real container server reports failure as a thrown error or as a
   non-throwing `{ success: false }` response. `CloudflareComputeBackend` (in
   `src/compute/backends/cloudflare.ts`) already raises a `ComputeError` on a
   `{ success: false }` result (see `ensureSuccess`/`guard`) — confirm that
   codepath is real (i.e. the SDK does sometimes return `success: false` rather
   than always throwing), and equally important, confirm a **successful**
   operation is never misread as a failure by that same check.

6. **Discard, then reacquire through the same thread.** Discard a thread's
   compute, then reacquire it (still via `getSandbox` with the same
   `ws_<workspaceId>_<threadId>` id) without going through Nadi's recoverable
   release/backup path. Confirm this silently yields a **fresh, empty**
   container rather than any kind of `runtime_missing` error. This divergence
   from Daytona (where a discarded runtime does report missing) is encoded as
   `reportsMissingRuntimeAfterDiscard: false` in
   `test/unit/compute/backend-contract.test.ts`; this step is what confirms the
   encoded assumption is actually how Cloudflare behaves.

7. **Host restriction rejects before container creation.** Configure a
   workspace with a non-empty `allowedHosts` and attempt to acquire Cloudflare
   compute for a thread. Confirm the acquire throws `policy_rejected`
   (`cloudflare_no_network_policy`, thrown early in `acquire()` in
   `src/compute/backends/cloudflare.ts`) and — critically — that **no
   container is created** as a side effect before the rejection. The SDK has no
   network-policy API at all (`setAllowedHosts` does not exist in
   `@cloudflare/sandbox@0.12.3`), so this fail-closed check is the only thing
   standing between a restricted workspace and unrestricted egress; confirm it
   actually fires and fires first.

8. **Full recoverable lifecycle.** Let a thread's compute idle out (or force an
   idle release) so it goes through the recoverable release path. Confirm:
   - a backup object appears in the `nadi-compute-backups` R2 bucket;
   - reacquiring compute for that thread lazily restores from that backup;
   - the restored `/workspace` contents match what was there before release,
     byte for byte for at least one test file;
   - a final explicit discard leaves no container running (verify via
     `pnpm wrangler containers list` or equivalent) and, ideally, that the R2
     backup object used for the restore is cleaned up per Nadi's recovery TTL
     policy rather than left indefinitely (the 8-day bucket lifecycle rule is
     only the backstop, not the primary mechanism).

9. **A failed `createBackup` does not destroy the container.** Confirm that if
   a backup attempt fails (e.g. by simulating a transient error, or reasoning
   from the code path rather than forcing a real failure destructively in
   production — do not deliberately break a production backup to test this),
   the container is left running and usable. `CloudflareComputeBackend` treats
   a backup failure as `provider_transient` (see `cloudflare_backup_failed` in
   `src/compute/backends/cloudflare.ts`) and does not tear down the runtime;
   confirm this by inspecting the code path and, where safely possible,
   observing that a thread survives a backup error and can still be used
   afterward.

### Recording results

For each smoke run, record:

| Field | Example |
|---|---|
| Date | 2026-07-15 |
| Worker version id | (from `wrangler deployments list` or the dashboard) |
| Image tag | `nadi-cloudflare-sandbox:0.12.3` (or the pushed registry tag) |
| Result | pass / fail per checklist item above, plus notes |

Never record secret values, file contents, or paths/contents from a real user
workspace in this table or anywhere else in this document.
