# Architecture

The tour for someone about to change the code. [`README.md`](../README.md) has
the diagram and the one-line version; this is where each box earns its place.

## One Worker, many Durable Objects

Nadi deploys as a single Cloudflare Worker (`src/index.ts`). It has three jobs:

1. **Serve the SPA.** The React 19 build ships as static assets (`ASSETS`).
2. **Own the REST surface.** Everything under `/api/*` — auth, settings,
   threads, projects, workbenches, automata, invites — is handled in
   `src/http/`.
3. **Route agent traffic.** Authenticated `/agents/*` and `/think-agents/*`
   requests are delegated to the Agents SDK, which resolves them to a Durable
   Object.

State that must be *shared* lives in D1. State that must be *serialized* lives
in a Durable Object. That split explains most of the codebase.

### The Durable Objects

| Binding | Class | Holds |
| --- | --- | --- |
| `THINK_THREAD_AGENT` | `ThinkThreadAgent` | One chat thread: history, tool loop, compute lease. The current runtime. |
| `THREAD_AGENT` | `ThreadAgentV2` | The legacy runtime. Still bound for old threads; not where new work goes. |
| `WORKSPACE_MCP_AGENT` | `WorkspaceMcpAgent` | MCP client connections, shared per workspace so every thread does not redial. |
| `USER_HUB` | `UserHub` | Per-user fan-out: thread list updates, unread state, push. |
| `VOICE_AGENT` | `VoiceAgent` | Composer dictation sessions. |
| `NADI_SANDBOX_SMALL` / `_MEDIUM` | `NadiSandbox*` | Cloudflare Sandbox containers, one instance per (workspace, thread). |

A thread DO is single-threaded, which is the point: a turn, its tool calls and
its compute lease cannot interleave with another turn on the same thread. It is
also the constraint behind several designs — anything that RPCs into a busy DO
must be time-boxed, because it queues behind whatever that DO is doing.

**Reach a DO with `getAgentByName`, never `namespace.get(idFromName(...))`.** The
raw stub skips the entry points where `onStart()` runs, so the agent wakes up
without its MCP servers or its scheduled alarms.

## Where state lives

- **DO SQLite** — the live conversation. The Agents SDK and the Think runtime own
  the schema here (`cf_agents_*`, `cf_think_*`); there is no hand-rolled message
  store, and none of these tables are ours to migrate.
- **D1 (`REGISTRY_DB`)** — everything else: workspaces, agents, MCP servers and
  tool policy, workbenches, projects, automata, invites, and the
  active-container ledger.

  It is **not** only a control plane, whatever the binding name suggests.
  Conversation content lives here too, in three places: `thread_index`
  carries `last_message_preview`, `thread_search_messages` is a full-text index
  over messages, and `archived_message` holds the messages of archived threads.
  Worth knowing before you reason about where a user's words end up.
- **R2** — `ATTACHMENTS_BUCKET` for uploads, `BACKUP_BUCKET` for sandbox
  `/workspace` snapshots taken when a container is released.
- **KV (`SECRETS_KV`)** — encrypted workspace secrets: provider keys, sandbox
  credentials, per-workbench env secrets. Names are mirrored into D1 because
  `kv.list` is eventually consistent and a freshly written secret would
  otherwise not appear.

The thread index in D1 is a *projection*. The DO is the source of truth for
messages; D1 carries what the list view needs so the sidebar does not have to
wake every thread.

## A turn, end to end

1. The SPA opens a WebSocket to the thread's DO and sends a message.
2. `ThinkThreadAgent` resolves its runtime config — model, reasoning effort,
   tools — from D1 and the workspace secrets.
3. Tools are assembled: built-ins, compute tools, and MCP tools wrapped by the
   D1-backed policy (`deny` omits the tool; `approval_required` sets
   `needsApproval`; `auto_allow` passes through). Approvals are signed with
   `TOOL_APPROVAL_SECRET`, so a forged approval is rejected.
4. The model streams. Tool calls that need compute acquire a sandbox lazily —
   the first tool call pays for provisioning, not the first message.
5. Output streams back over the socket and is persisted by the SDK. `UserHub`
   is notified so other surfaces update.
6. When the thread goes idle an alarm releases the sandbox, backing up
   `/workspace` first so the next turn can restore it.

Context is managed by `src/agent/compaction.ts`: a budget derived from the
model's context window, with the middle of the transcript summarized into an
overlay when it is exceeded.

## Compute

`src/compute` is provider-neutral. A backend implements acquire / exec / file
ops / release against `ComputeBackend`, and callers never branch on the
provider:

- **Daytona** (`backends/daytona.ts`) — sandboxes from a snapshot, either
  system-managed on the operator's `DAYTONA_API_KEY` or BYOK from a workspace
  secret. Supports an egress allowlist, with caveats worth reading in the
  README's Known issues.
- **Cloudflare Sandbox** (`backends/cloudflare.ts`) — containers as Durable
  Objects. No network-policy API, so it fails closed on a non-empty allowlist.
- **Mock** (`backends/mock.ts`) — in-memory, for local dev and tests.
  `DEFAULT_SANDBOX_PROVIDER=mock` in `.dev.vars`.

Which provider a workspace uses is a **stored column**, written once at
provisioning from `DEFAULT_SANDBOX_PROVIDER`. Changing that variable affects new
workspaces only.

A workspace's concurrently-live sandboxes are capped by
`MAX_ACTIVE_CONTAINERS_PER_WORKSPACE`, enforced through the D1 ledger in
`compute/container-ledger.ts`. At the cap, the least-recently-used idle sandbox
is reclaimed before the request is refused.

## Auth

Better Auth with email OTP, persisted to D1 through the Drizzle adapter. Sign-in
is invite-gated: an uninvited address is recorded on a waiting list and no OTP
is ever sent. Sessions are validated against the Better Auth store, and renewal
happens on `/api/auth/get-session` — the only caller that refreshes, which is
worth knowing before you optimize a call away.

## The frontend

`web/` is a separate package: React 19, Tailwind v4, shadcn/ui, Vite. It is a
PWA with a service worker that precaches the shell and serves history read-only
when offline.

Notable: it is **excluded from the root formatter** (see `.prettierignore`), so
format `web/` from inside `web/`. Conventions, the design system and the mocked
app live in [`AGENTS.md`](../AGENTS.md).

## Tests

Four vitest projects, defined in `vitest.config.ts`:

| Project | Environment | Covers |
| --- | --- | --- |
| `unit` | node | pure logic, `src/` |
| `web-unit` | jsdom | `web/src` components and libs |
| `integration-fast` | workers pool | D1, KV, routes, shared miniflare |
| `integration-isolated` | workers pool | tests needing their own instance |

Run them with `pnpm vitest run --fileParallelism=false` — the workers pool is
memory-hungry and parallel files will OOM a small machine. See
[`CONTRIBUTING.md`](../CONTRIBUTING.md).
