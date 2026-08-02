# Nadi

Mobile-first agentic chat: an authenticated AI thread inbox where manual chats
and policy-gated MCP tool calls share one run model.

## Architecture

Nadi is a Cloudflare Worker with a React 19 SPA frontend. The key components:

- **AIChatAgent (Agents SDK)** — each chat thread is a Durable Object extending
  `AIChatAgent<Env>`. The SDK owns message persistence (DO SQLite) and the
  `CF_AGENT_*` WebSocket protocol; there is no hand-rolled message store.

- **AI SDK (`streamText`)** — inference and the tool loop run through the AI SDK
  (`ai` + `@ai-sdk/openai` / `@ai-sdk/anthropic` / `@openrouter/ai-sdk-provider`).
  `onChatMessage` calls `streamText(...)` and returns
  `result.toUIMessageStreamResponse()`.

- **MCP tools via `this.mcp`** — MCP servers are attached in `onStart` with
  `this.addMcpServer`. `this.mcp.getAITools()` is wrapped with a D1-backed
  policy: `deny` → tool omitted; `approval_required` → `needsApproval: true`;
  `auto_allow` → `needsApproval: false`.

- **HITL approval (SDK-native)** — human-in-the-loop approval state is persisted
  in the SDK message parts. There are no custom approval tables. The
  `experimental_toolApprovalSecret` env secret prevents forgery.

- **Better Auth email OTP** — authentication is handled by Better Auth, persisted
  to D1 via the Drizzle adapter. Session cookies are checked for presence in the
  Worker before routing to the agent (MVP: cookie-presence only; full session
  validation against the Better Auth D1 store is a follow-up).

- **Worker routing** — the Worker auth-gates `/agents/*` requests (returns 401
  without a valid session), then delegates to `routeAgentRequest`. Auth routes
  (`/api/auth/*`) are handled by Better Auth directly.

- **D1 (registry / control plane)** — stores workspaces, agents, MCP server
  configs, and tool policies. Schema lives in `src/db/schema.ts`; migrations are
  drizzle-generated (see below).

> **Routines (scheduled dispatch) are intentionally deferred** — the cron trigger
> and `scheduled` handler are no-ops and will return with the routines feature in
> a separate implementation plan.

## Local Development

```bash
# 1. Install deps
pnpm install

# 2. Copy the env example and fill in your secrets
cp .dev.vars.example .dev.vars
# edit .dev.vars: add BETTER_AUTH_SECRET, TOOL_APPROVAL_SECRET, and your LLM API key

# 3. Apply database migrations
pnpm run db:migrate:local

# 4. Start the Worker (backend)
pnpm run dev            # wrangler dev on http://localhost:8787

# 5. Start the SPA (frontend, in a second terminal)
pnpm run web:dev        # vite dev on http://localhost:5173
```

## Database migrations

Schema lives in `src/db/schema.ts`. Migrations are **drizzle-generated** — the
SQL in `migrations/` is never hand-edited.

```bash
# After changing src/db/schema.ts:
pnpm run db:generate        # generate migration SQL (drizzle-kit)
pnpm run db:migrate:local   # apply to local D1 (wrangler runs drizzle-generated SQL)

# Deploy:
pnpm run db:migrate:remote  # apply to live Cloudflare D1
```

See [docs/runbooks/local-dev.md](docs/runbooks/local-dev.md) for the full workflow.

## Compute providers

Agent tools (exec, file read/write/patch) run on pluggable compute: Daytona or
Cloudflare Sandbox Containers. See
[docs/operations/cloudflare-sandbox.md](docs/operations/cloudflare-sandbox.md)
for Cloudflare provisioning, deployment (building the container image requires
Docker), and the real-provider smoke checklist.

## Specs

- [MVP architecture](docs/specs/2026-06-27-mvp-architecture.md)
