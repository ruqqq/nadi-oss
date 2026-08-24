# Running Nadi on celld, packaged

This directory packages a Nadi deployment on [celld](https://github.com/denoland/celld)
as Docker images and a Compose stack — Caddy serving the SPA and terminating
TLS, a celld node behind it, and optionally a bundled MinIO.

For the concepts underneath — what works on celld and what does not, why the
vars file is not JSON, how scheduled work survives a restart — read
[`docs/self-hosting-celld.md`](../../docs/self-hosting-celld.md). This file
covers operating the packaged stack, in both topologies.

## Pick a topology first

|                            | Single node                         | Multi node                                               |
| -------------------------- | ----------------------------------- | -------------------------------------------------------- |
| Status                     | **Run end to end**                  | **Untested** — a starting point                          |
| Hosts                      | one                                 | one full copy of the stack per host                      |
| S3                         | bundled MinIO, or external          | external only                                            |
| Survives a host dying      | no                                  | yes, at a cost — see [failover](#what-failover-costs)    |
| Planned restart loses data | no, with `./drain-stop.sh`          | no, with a drain per host                                |
| Unplanned host loss        | whatever has not reached the bucket | same, but now it is the case you added a node to survive |

**Start with single node — but the durability argument changed in v0.3.0.**
Through v0.2.1 a second node bought availability and cost durability: failover
restored cells from the bucket and discarded the rest without surfacing an error
anywhere. celld v0.3.0 adds a replicated write-behind log for fleets of two or
more, acknowledging a write after **peer fsync** with the bucket upload behind
it, which upstream measures at 10x lower write latency and 100x fewer S3 Class A
operations.

So single node is now the recommendation because it is the _tested_ topology
here and the simpler one to operate — not because a second node is worse for
your data. Neither the write-behind log nor failover has been measured on this
deployment; if you scale out, measure it before trusting it.

## What is in here

| File                            |                                                                                                |
| ------------------------------- | ---------------------------------------------------------------------------------------------- |
| `Dockerfile`                    | three targets: `web-server` (Caddy + SPA), `deployer` (one-shot bundle+upload), `node` (celld) |
| `Caddyfile`                     | shared by both topologies; site addresses come from the env file                               |
| `docker-compose.yaml`           | **single node**, with an optional bundled MinIO                                                |
| `.env.example`                  | Compose config for the single-node stack                                                       |
| `docker-compose.multinode.yaml` | **multi node**, one copy per host                                                              |
| `.env.multinode.example`        | Compose config for one host of a cluster                                                       |
| `celld-vars.env.example`        | application config and secrets, both topologies                                                |
| `drain-stop.sh`                 | stop the single-node stack without losing data                                                 |

Two config files, and the split matters: `.env*` configures **Docker**
(hostnames, buckets, the credentials celld uses for its fleet bucket), while
`celld-vars.env` is delivered to the **Worker** at runtime as variable
overrides. Both are gitignored; only the `.example` copies are tracked.

`wrangler.celld.jsonc` needs no editing. It is read only by `celld deploy`,
which bakes its `vars` into the uploaded bundle — the node takes no `--config`
at all — so per-deployment values belong in `celld-vars.env`.

---

# Single node

```sh
cp .env.example .env                        # hostnames, bucket, S3 credentials
cp celld-vars.env.example celld-vars.env    # app config and secrets
```

Edit both. `DEFAULT_SANDBOX_PROVIDER` in `celld-vars.env` is required and
nothing sets it for you — unset resolves to `cloudflare`, which celld
structurally cannot run, and the failure takes down whole message submissions
rather than just the sandbox tools.

On a real server, point both hostnames at the machine **before** first start:
Caddy issues certificates on startup and Let's Encrypt rate-limits failures.

```sh
docker compose --profile minio up -d     # only if you want the bundled S3
docker compose run --rm deploy           # bundle + upload the Worker
docker compose up -d                     # celld + Caddy
docker compose run --rm migrate          # apply migrations/ to the registry
```

`migrate` runs last and is not optional on a new deployment: the registry
database is a cell, so `celld d1` needs a live node to reach it.

Then sign in — Nadi is invite-only, so the first account must be listed in
`SUPERUSER_EMAILS`, or the request is accepted and quietly added to a waiting
list instead. See
[step 5 of the main guide](../../docs/self-hosting-celld.md#5-first-sign-in).

### Locally, with no domain and no certificates

The fastest way to try it. Give all three site addresses `.localhost` names
with an explicit `http://` scheme:

```sh
NADI_SITE=http://app.localhost
ARTIFACTS_SITE=http://artifacts.localhost
S3_SITE=http://s3.localhost
S3_HOSTNAME=s3.localhost
```

Neither detail generalises: `http://` turns Caddy's auto-HTTPS off, and
`.localhost` is required because the app mints `http://` artifact origins only
for `localhost` and `*.localhost` hosts. `nadi.test` would produce artifact
URLs on an origin nothing serves.

### Deploying a change

Both images bake the repo in with `COPY . .`, so **rebuild before deploying**:

```sh
docker compose build deploy      # Worker changes (src/)
docker compose run --rm deploy
./drain-stop.sh --restart        # a node loads a deployment at startup only

docker compose build caddy       # SPA changes (web/) — no redeploy needed
docker compose up -d caddy
```

Skipping the build does not fail. It prints `Uploaded nadi` and a
`Current Version ID` exactly as a real deploy does, then serves the old code.
The Version ID is a content hash, so an unchanged one after a real source
change means nothing was rebuilt.

### Stopping

**Use `./drain-stop.sh`, not `docker compose down`.** The script cuts traffic,
waits past the eviction threshold so every cell replicates, and only then stops
the node. Stopping mid-traffic discards everything written since the last
eviction — on a healthy machine, with the disk intact. Preserving celld's local
working directory does not help; a kill with the same container restarted loses
the same data.

There is also a separate failure that draining does **not** prevent: under
concurrent writes, celld can replicate a chain missing pages it references,
leaving that cell permanently unrecoverable (`RestoreFailed` /
`missing page N in restore plan (incomplete backup)`). Measured to survive a
graceful `SIGTERM` stop as well as a hard kill, because the damage is done
during the writes rather than at shutdown. See the durability section of
[the main guide](../../docs/self-hosting-celld.md#durability-read-this-before-you-rely-on-it).

Persistent state is a bind mount under `./data/`, not a named volume, so even
`docker compose down -v` leaves it intact. That is a backstop for the volume,
not for the eviction rule.

---

# Multi node

> **Untested.** The single-node stack above has been run end to end. This one
> has not. It is derived from celld's documented flags and from how the
> single-node stack actually behaves — a starting point to debug from, not a
> recipe to trust. Verify [what failover costs](#what-failover-costs) yourself,
> on data you can afford to lose.

celld is a distributed runtime — `--peer`, `CELLD_TTL_MS` node leases and
`CELLD_PRESSURE_OWNERSHIP` are all cluster machinery. "One node" is a property
of the single-node stack, not a limit of celld.

## The shape

Every host runs a complete copy: one celld node, one Caddy. No separate
application tier, no leader.

```
                    DNS round-robin, or your cloud LB
                    (terminates TLS; no session affinity needed)
                     │            │            │
              ┌──────┴─────┐┌─────┴──────┐┌────┴───────┐
              │  host A    ││  host B    ││  host C    │
              │  caddy :80 ││  caddy :80 ││  caddy :80 │
              │    │       ││    │       ││    │       │
              │  celld:8080││  celld:8080││  celld:8080│  ← Worker routes
              │      :8081 ││      :8081 ││      :8081 │  ← peers + operator API
              └──────┬─────┘└─────┬──────┘└────┬───────┘
                     └─ peer mesh on :8081, private network, PLAINTEXT ─┘
                                  │
                       external S3: the fleet bucket
                       (this bucket IS the cluster)
```

Two properties do most of the work:

**Any node can answer any request.** celld routes internally to whichever node
currently owns the cell. So the load balancer needs no stickiness and
WebSockets survive a plain round-robin — a browser can land on host C for a
thread whose cell lives on host A and it just works. This is why there is no
separate proxy tier to configure.

**The fleet bucket is the cluster's identity.** Nodes discover each other by
writing leases into it. Two nodes pointed at different buckets are not a
cluster; they are two applications that will never notice each other, and
nothing will tell you.

## Prerequisites

- **A private network between the hosts.** Peer traffic is unencrypted, and
  the same internal port serves an operator API that permits unauthenticated
  state inspection, eviction and shutdown. celld refuses to advertise a public
  IP unless you set `CELLD_UNSAFE_PUBLIC_ADVERTISE=1`, and that flag is named
  accurately. A cloud VPC, a private-networking interface, or WireGuard. Not
  the open internet.
- **External S3.** R2, AWS, or a MinIO cluster of its own. Every node must
  reach the same bucket, so the bundled single-host MinIO is not an option and
  the multi-node stack has no `minio` profile.
- **A load balancer or round-robin DNS** in front, terminating TLS. See
  [Certificates](#certificates).

## Setup

Per host:

```sh
cp .env.multinode.example .env.multinode    # edit: two values are per-host
cp celld-vars.env.example celld-vars.env    # identical on EVERY host
```

`celld-vars.env` must be byte identical across the cluster. A node that
disagrees about `BETTER_AUTH_SECRET` or `SECRETS_STORE_KEK_RAW_B64` will issue
sessions and encrypt secrets its peers cannot read, and the symptom is users
being randomly signed out depending on which node they hit — not an error.

In `.env.multinode`, exactly two values differ per host:

| Variable          | Host A           | Host B           |
| ----------------- | ---------------- | ---------------- |
| `CELLD_ADVERTISE` | `10.0.0.11:8081` | `10.0.0.12:8081` |
| `PEER_BIND_IP`    | `10.0.0.11`      | `10.0.0.12`      |

`CELLD_ADVERTISE` is the address **peers dial**, so it cannot be a Docker
service name, and since celld v0.2.0 it names the _internal_ listener (8081),
not the public Worker port (8080). The single-node file has no peers and omits
it entirely.

Then once, from any host:

```sh
docker compose -f docker-compose.multinode.yaml --env-file .env.multinode \
  --profile deploy run --rm deploy
```

And on every host:

```sh
docker compose -f docker-compose.multinode.yaml --env-file .env.multinode up -d
```

Confirm the nodes actually found each other before sending traffic — a split
cluster looks completely healthy from any single host:

```sh
celld diagnose --bucket s3://celld-fleet --endpoint <your endpoint>
```

## Rolling restarts and deploys

A deploy is cluster-wide and immediate; picking it up is not. The bucket
records one current deployment, and **nodes read a deployment only at
startup**. Between the first and last node restarting, the cluster runs two
versions of the Worker against one set of shared state.

Keep that window short, and avoid deploying a change that alters stored shapes
in a way the old version cannot read — ordinary rolling-deploy discipline,
except the two versions share Durable Object state directly.

`./drain-stop.sh` targets the single-node stack (it assumes the default compose
file and `.env`). Per host, the equivalent is:

```sh
CF=docker-compose.multinode.yaml
EF=.env.multinode

# 1. take this host out of the LB — how depends on your LB
# 2. stop local traffic
docker compose -f $CF --env-file $EF stop caddy
# 3. wait past the eviction threshold so this node's cells replicate
sleep 35
# 4. restart the node; it loads the current deployment now
docker compose -f $CF --env-file $EF restart celld
docker compose -f $CF --env-file $EF start caddy
# 5. put it back in the LB, confirm it is serving, then move to the next host
```

Step 3 is the one people skip. Without it, restarting the node discards
whatever its cells have written since they last idled — the same silent loss as
a crash, except deliberate. Do one host at a time.

## Certificates

The example `.env.multinode` gives every `*_SITE` an explicit `http://` scheme,
which turns Caddy's automatic HTTPS **off** and assumes your load balancer
terminates TLS. That is deliberate.

The alternative — a bare hostname, so each Caddy issues its own certificate —
uses an HTTP-01 challenge, and HTTP-01 requires the validation request to reach
the _same_ Caddy that started it. Behind round-robin DNS it usually does not,
so issuance flaps and Let's Encrypt rate-limits you out.

If you have no load balancer and want per-node certificates, use a **DNS-01**
challenge instead: build Caddy with your DNS provider's module and configure
the challenge in the Caddyfile. Do not simply drop the `http://`.

The browser-facing URL is `https://` either way, so `APP_BASE_URL` in
`celld-vars.env` stays `https://`. Only Caddy's own view, on the private side
of the LB, is plain HTTP.

## Still single-node in this repo

- **`./drain-stop.sh`** targets the default compose file and `.env`. Use the
  inline commands above.
- **The `minio` profile** is single-host by construction, and absent here.
- **`./data/`** is host-local. In the multi-node stack it holds only Caddy's
  certificates and config.

---

# What failover costs

The section to understand before running more than one node.

celld replicates a cell to the bucket only when that cell goes **idle**. When a
node dies, a peer takes over its cells once the dead node's lease expires and
restores each one **from the bucket** — that is, from its last idle
replication. Everything written to those cells since then is discarded.

There is no error. No 500, nothing in a log, no user-visible failure. The cell
resumes from an older state, and a message someone sent ten seconds before the
crash is gone.

The exposure window is roughly:

```
CELLD_TTL_MS  +  CELLD_IDLE_EVICT_S     ≈ 25s at the defaults
(lease expiry)   (age of last replication)
```

A _busy_ cell is the worst case, because it never goes idle and so never
replicates. The cells carrying an active conversation are exactly the ones with
the most to lose.

Lower `CELLD_IDLE_EVICT_S` to shrink the window, at the cost of more
replication traffic. It must stay well under the scheduler's 60s tick — past
that the registry cell never idles at all.

This is the same mechanic as the single-node warning about `docker compose
down`, with one difference: on one node it only bites on an unclean stop, and
`./drain-stop.sh` avoids it entirely. In a cluster it bites on any unplanned
host loss — the event you added the second node to survive.

**Backups are unchanged and matter more than replication.** Version or sync the
fleet bucket. Replication across nodes is not a backup: it is the same data, and
a bad deploy or a bad delete reaches all of it.

# Troubleshooting

See the [troubleshooting section of the main guide](../../docs/self-hosting-celld.md#troubleshooting)
— missing sign-in codes, `cloudflare_config_missing`, a deploy that appears to
do nothing, a vars file that is accidentally JSON, and Caddy refusing to start
on an empty `*_SITE`.
