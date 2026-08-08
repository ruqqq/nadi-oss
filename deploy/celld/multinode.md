# Nadi on a celld cluster

> **This path is untested.** The single-node stack in this directory has been
> run end to end. This one has not. It is derived from celld's documented flags
> and from how the single-node stack actually behaves, and it is offered as a
> starting point to debug from — not a recipe to trust. If you take it to
> production, verify the failover behaviour described under
> [What failover costs](#what-failover-costs) yourself, on data you can afford
> to lose.

Read [docs/self-hosting-celld.md](../../docs/self-hosting-celld.md) first. This
document only covers what changes when there is more than one node.

## Should you?

Probably not yet, and it is worth being blunt about why.

A second node does not make Nadi more durable. It makes it _available_ — a host
can die without the app going down — but it introduces failover, and failover
is the one operation in this system that loses data silently. One node with a
low `CELLD_IDLE_EVICT_S`, a real backup of the fleet bucket, and
`./drain-stop.sh` for planned restarts is a stronger durability posture than
three nodes are.

Scale out when you need availability or capacity, and go in knowing what it
costs.

## The shape

Every host runs a complete copy of the stack: one celld node, one Caddy. There
is no separate application tier and no leader.

```
                    DNS round-robin, or your cloud LB
                    (terminates TLS; no session affinity needed)
                     │            │            │
              ┌──────┴─────┐┌─────┴──────┐┌────┴───────┐
              │  host A    ││  host B    ││  host C    │
              │  caddy :80 ││  caddy :80 ││  caddy :80 │
              │    │       ││    │       ││    │       │
              │  celld:8080││  celld:8080││  celld:8080│
              └──────┬─────┘└─────┬──────┘└────┬───────┘
                     └──── peer mesh, private network, PLAINTEXT ────┘
                                  │
                       external S3: the fleet bucket
                       (this bucket IS the cluster)
```

Two properties do most of the work:

**Any node can answer any request.** celld routes internally to whichever node
currently owns the cell. So the load balancer needs no stickiness, and
WebSockets survive a plain round-robin — a browser can land on host C for a
thread whose cell lives on host A and it just works. This is why there is no
separate proxy tier to configure.

**The fleet bucket is the cluster's identity.** Nodes discover each other by
writing leases into it. Two nodes pointed at different buckets are not a
cluster; they are two applications that will never notice each other, and
nothing will tell you.

## Prerequisites

- **A private network between the hosts.** Peer traffic is unencrypted. celld
  refuses to advertise a public IP unless you set
  `CELLD_UNSAFE_PUBLIC_ADVERTISE`, and that flag is named accurately. A cloud
  VPC, a private-networking interface, or WireGuard — any of those. Not the
  open internet.
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
being randomly signed out depending on which node they hit — not an error
message.

In `.env.multinode`, exactly two values differ per host:

| Variable          | Host A           | Host B           |
| ----------------- | ---------------- | ---------------- |
| `CELLD_ADVERTISE` | `10.0.0.11:8080` | `10.0.0.12:8080` |
| `PEER_BIND_IP`    | `10.0.0.11`      | `10.0.0.12`      |

`CELLD_ADVERTISE` is the address **peers dial**, so it cannot be a Docker
service name. The single-node file passes `--advertise celld:8080` and gets
away with it only because it has no peers; copying that into a cluster gives
every node the same unroutable name.

Then, once, from any host:

```sh
docker compose -f docker-compose.multinode.yaml --env-file .env.multinode \
  --profile deploy run --rm deploy
```

And on every host:

```sh
docker compose -f docker-compose.multinode.yaml --env-file .env.multinode up -d
```

Check that the nodes actually found each other before you send traffic — a
split cluster looks completely healthy from any single host:

```sh
celld diagnose --bucket s3://celld-fleet --endpoint <your endpoint>
```

## What failover costs

This is the section to understand before anything else.

celld replicates a cell to the bucket only when that cell goes **idle**. When a
node dies, a peer takes over its cells once the dead node's lease expires and
restores each one **from the bucket** — that is, from its last idle
replication. Everything written to those cells since then is discarded.

There is no error. No 500, nothing in a log, no user-visible failure. The cell
simply resumes from an older state, and a message someone sent ten seconds
before the crash is gone.

The exposure window is roughly:

```
CELLD_TTL_MS  +  CELLD_IDLE_EVICT_S     ≈ 25s at the defaults
(lease expiry)   (age of last replication)
```

A _busy_ cell is the worst case, because it never goes idle and so never
replicates. The cells carrying an active conversation are exactly the ones with
the most to lose.

Lower `CELLD_IDLE_EVICT_S` to shrink the window, at the cost of more
replication traffic. It has to stay well under the scheduler's 60s tick — past
that the registry cell never idles at all.

This is the same mechanic as the single-node warning about `docker compose
down`, with one important difference: on one node it only bites on an unclean
stop, and `./drain-stop.sh` avoids it entirely. In a cluster it bites on any
unplanned host loss, which is the event you added the second node to survive.

## Rolling restarts and deploys

A deploy is cluster-wide and immediate; picking it up is not. The bucket
records one current deployment, and **nodes read a deployment only at
startup**. So between the first and last node restarting, your cluster is
running two versions of the Worker against one set of shared state.

Keep that window short, and avoid deploying a change that alters stored shapes
in a way the old version cannot read — the same discipline as any rolling
deploy, except that here the two versions share Durable Object state directly.

`./drain-stop.sh` is written for the single-node stack (it assumes the default
compose file and `.env`). Per host, the equivalent is:

```sh
CF=docker-compose.multinode.yaml
EF=.env.multinode

# 1. take this host out of the LB — how depends on your LB
# 2. stop local traffic
docker compose -f $CF --env-file $EF stop caddy ticker-watchdog
# 3. wait past the eviction threshold so this node's cells replicate
sleep 35
# 4. restart the node; it loads the current deployment now
docker compose -f $CF --env-file $EF restart celld
docker compose -f $CF --env-file $EF start caddy ticker-watchdog
# 5. put it back in the LB, confirm it is serving, then move to the next host
```

Step 3 is the one people skip. Without it, restarting the node discards
whatever its cells have written since they last idled — the same silent loss as
a crash, except you caused it on purpose.

Do one host at a time.

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

The browser-facing URL is still `https://` in either case, so `APP_BASE_URL` in
`celld-vars.env` stays `https://`. Only Caddy's own view, on the private side
of the LB, is plain HTTP.

## Things that are still single-node in this repo

Known gaps, so you are not surprised by them:

- **`./drain-stop.sh`** targets the default compose file and `.env`. Use the
  inline commands above.
- **The `minio` profile** is single-host by construction, and absent here.
- **`deploy/celld/data/`** is host-local. In this stack it holds only Caddy's
  certificates and config; your actual data lives in the fleet bucket.
- **Backups** are unchanged and still the thing that matters most: version or
  sync the fleet bucket. Replication across nodes is not a backup — it is the
  same data, and a bad deploy or a bad delete reaches all of it.
