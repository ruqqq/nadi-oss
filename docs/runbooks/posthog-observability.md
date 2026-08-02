# PostHog Observability Runbook

Nadi reports to PostHog on two surfaces, joined at the **workspace group**:

- **Backend (LLM/AI observability)** — `@posthog/ai` `withTracing` wraps the model
  in the `streamText` run loop (`src/agent/thread-agent.ts` → `onChatMessage`),
  emitting `$ai_trace` / `$ai_generation` events (model, tokens, cost, latency,
  finish reason, tool calls). Run-loop errors are captured as `$exception` on the
  trace. Boundary code lives in `src/observability/posthog.ts`.
- **Frontend (product analytics)** — `posthog-js` with autocapture + named events
  (`web/src/lib/posthog.ts`).

> **Everything is a no-op until keys are set.** With no `POSTHOG_KEY` (backend) or
> `VITE_POSTHOG_KEY` (frontend), instrumentation is fully bypassed and chat
> behavior is unchanged. It is safe to deploy before configuring PostHog.

---

## 1. Create the PostHog project (one-time)

Create **one** PostHog project for Nadi — it serves both backend and frontend.
From **Project Settings** grab:

| Value | Where |
| --- | --- |
| **Project API key** (`phc_…`) | Project Settings → API Keys |
| **Host** | US: `https://us.i.posthog.com` · EU: `https://eu.i.posthog.com` |

The same `phc_…` key is used by both surfaces.

---

## 2. Configuration

### Backend (Worker)

The key is a **secret**; host and content-capture are plain **vars** committed in
`wrangler.jsonc`.

| Name | Type | Default | Notes |
| --- | --- | --- | --- |
| `POSTHOG_KEY` | secret | _(unset → no-op)_ | `wrangler secret put POSTHOG_KEY` (+ `.dev.vars` locally) |
| `POSTHOG_HOST` | var (`wrangler.jsonc`) | `https://us.i.posthog.com` | Change to the EU host if your project is EU |
| `POSTHOG_CAPTURE_CONTENT` | var (`wrangler.jsonc`) | `"true"` | `"true"` captures prompts/outputs/tool args; **anything else ⇒ metadata only (redacted)** |

```bash
# deployed worker secret:
pnpm exec wrangler secret put POSTHOG_KEY      # paste the phc_… key

# local dev (.dev.vars is gitignored):
echo 'POSTHOG_KEY=phc_xxx' >> .dev.vars
```

> **Privacy:** the content gate is strict — content is sent **only** when
> `POSTHOG_CAPTURE_CONTENT` is exactly the string `"true"`. Set it to `"false"`
> (or any other value) to send metadata only.

### Frontend (Vite — build-time)

These are **baked into the bundle at build time**, so they must be present when
`web:build` runs (the worker serves the prebuilt `web/dist`).

```bash
# web/.env.local (gitignored) for local dev:
VITE_POSTHOG_KEY=phc_xxx
VITE_POSTHOG_HOST=https://us.i.posthog.com
```

If `VITE_POSTHOG_KEY` is absent at build time, frontend init is skipped.

---

## 3. Deploy

There is no combined deploy script. The worker serves `web/dist`, so **build the
SPA first (with the frontend env present), then deploy the worker**:

```bash
# 1) build the SPA with the frontend env baked in
VITE_POSTHOG_KEY=phc_xxx VITE_POSTHOG_HOST=https://us.i.posthog.com pnpm web:build

# 2) deploy the worker (bundles web/dist + the backend secret/vars)
pnpm exec wrangler deploy
```

`POSTHOG_KEY` (set via `wrangler secret put`) persists on the deployed worker —
set it once.

---

## 4. Verify

1. Send a chat message → PostHog **AI observability** shows `$ai_trace` /
   `$ai_generation` events with `distinct_id` = the **workspace id** and a
   `workspace` group.
2. Frontend events appear under the identified user: `message_sent`,
   `thread_created`, `tool_approval`, `settings_saved` (all metadata only — no
   message text).
3. Force a provider error (e.g. a bad key) → a `$exception` event lands on the
   same trace.

---

## Design decisions & known limitations

- **Workspace-level backend identity.** Backend traces use `distinct_id =
  workspaceId` and a `workspace` group — not per-user. (The DO resolves
  `workspaceId` but not `userId`; per-user backend attribution is a deferred
  upgrade.) Frontend events are per-user and join backend traces via the shared
  `workspace` group.
- **Workspace group binding (frontend).** `bindWorkspace` fires on thread
  *creation*, not on auth resolve (the session payload does not carry
  `workspaceId`). A returning user who opens an existing thread in a brand-new
  browser emits ungrouped events until they create a thread; `posthog.group()`
  then persists. Follow-up: surface `workspaceId` in the session or bind on
  active-thread load.
- **Session replay is OFF** (`disable_session_recording: true`); profiles are
  `identified_only`.
- **`settings_saved`** records the new provider/model, not a from→to transition
  (there is no in-chat model picker; the model changes only in agent settings).

See the design spec and implementation plan under `docs/superpowers/` for full
detail.
