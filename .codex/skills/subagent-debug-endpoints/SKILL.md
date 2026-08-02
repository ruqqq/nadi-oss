---
name: subagent-debug-endpoints
description: Drive and QA subagents + sandbox behavior headlessly (no UI) via the DEBUG_TOKEN-gated /api/debug endpoints. Use when reproducing or verifying subagent runs, background-process output capture, run timing/leases, or sandbox exec behavior on a deployed build — e.g. "verify a subagent captures its output", "reproduce the R1 empty-output bug", "check subagent run timing", "QA subagents without clicking through the app".
---

# Subagent & Sandbox Debug Endpoints

Token-gated HTTP endpoints (`/api/debug/*`, in `src/http/debug-routes.ts`) that
create a throwaway `think` thread and drive its sandbox + subagents directly —
no browser, no model-driven chat. Built to reproduce/verify the subagent
reliability work headlessly. Backed by `debug*` RPC methods on
`ThinkThreadAgent`.

## Gate & prerequisites

- **Auth:** every `/api/debug/*` route requires header `x-debug-token: <DEBUG_TOKEN>`.
  If `DEBUG_TOKEN` is unset or mismatched, the route returns a bare `404` (no
  existence signal). `DEBUG_TOKEN` is a prod secret + a `.dev.vars` line.
  Effectively an arbitrary-code-execution capability (runs shell in the
  sandbox) — keep the token strong; never expose it.
- **Base URL:** your deployment's canonical host (`CANONICAL_HOST`), or your
  local `wrangler dev` URL. A host listed in `LEGACY_HOSTS` **308-redirects** to
  it — the `curl` recipes below use no `-L`, so against a legacy base they return
  the redirect body and every `grep -o 'thr_…'` silently yields an empty id.
  Always use the canonical host.
- **Deploy/logs:** `export CLOUDFLARE_ACCOUNT_ID=<id>`; deploy with
  `pnpm run deploy`; tail logs with `npx wrangler tail nadi --format json`
  (add `--search <substr>` to filter).

## Endpoints

| Method + path                         | Body / query                                                        | Returns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/debug/thread`              | `?workspaceId=` (optional); body `{ provider?, model? }` (optional) | `{ threadId, workspaceId, agentId, provider, model }` — a registered throwaway `think` thread. Omit `provider`/`model` to inherit the workspace agent's default; pass both to pin the thread to a different model (validated against the supported-provider list + the workspace's actual usability, same gate a real thread's `PATCH` uses) — e.g. a small-context model so `/compact` seeds cheaply instead of against the owner's 1M-context default.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `POST /api/debug/exec-start`          | `{ threadId, command }`                                             | `{ processId, status }` — start a background command in the thread's sandbox                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `GET /api/debug/exec-output`          | `?threadId=&processId=`                                             | `{ status, exitCode, stdout, stderr }` — captured output (refreshes from the provider first)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `POST /api/debug/file-tools`          | `{ threadId }`                                                      | `{ steps: [{ step, ok, detail }] }` — drive `write_file` / `read_file` / `apply_patch` against the LIVE backend. Proves what `FakeComputeBackend` cannot: that the provider reports `type: "symlink"` (the path-escape guard) and that `movePath(overwrite)` replaces an existing destination (every in-place patch). Each step reports independently; one failure does not hide the rest.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `POST /api/debug/cloudflare-compute`  | `{ threadId }`                                                      | `{ steps: [{ step, ok, detail }] }` — drive the **live Cloudflare Sandbox provider** through every contract a fake can only assert. **⚠️ Each run creates a REAL Cloudflare container that costs money and shared disk.** The run self-cleans in a `finally`; use `/cloudflare-shutdown` to reclaim a wedged one. See below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `POST /api/debug/cloudflare-shutdown` | `{ threadId }`                                                      | `{ sandboxId, destroyed, errors }` — out-of-band cleanup: destroy the derived `ws_<workspaceId>_<threadId>` Cloudflare container on each configured binding. Run this if a `/cloudflare-compute` run was interrupted before its self-clean.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `POST /api/debug/sandbox-reset`       | `{ threadId }`                                                      | `{ provider, processId, generationBefore, generationAfter, generationState, generationDiverged, resetPathExercised, outcome, reason, reminderDelivered, reminderText, terminalViaExplicitSweep, postResetListing, elapsedMs, steps }` — prove against a **real container** that a sandbox reset is detected and reported to the model. `FakeComputeBackend` cannot OOM, so no unit test can settle this. `postResetListing` (`{ ok: true, entries }` or `{ ok: false, errorName?, errorMessage }`) is the raw SDK `listFiles("/tmp", { includeHidden: true })` answer — bypassing `inspectPath`/`isPathNotFound` entirely — settling whether a wiped container answers cleanly or throws. **⚠️ Each run boots a REAL Cloudflare container that costs money and shared disk.** Self-cleans in a `finally`; a failed self-clean is reported as a failed step. Cloudflare-only (fails as step 0 on any other provider). See below. |
| `POST /api/debug/work-healthy`        | `{ threadId, sleepSeconds? }` (25–120, default 30)                  | `{ provider, processId, generation, aliveAfterStaleWindow, stampAdvancedMs, outcome, reason, faultDelivered, faultText, elapsedMs, steps }` — the **false-fault** direction: a healthy process outliving `PROCESS_STALE_AFTER_MS` (21s) must stay `alive` and must never be faulted. Enforcement ships live, so this matters as much as the reset direction. **⚠️ Same money warning — a REAL container per run.** See below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `POST /api/debug/shutdown`            | `{ threadId }`                                                      | `{ ok, terminated, ... }` — destroy the thread's sandbox. **Call this after any debug run.** Every debug thread acquires a sandbox and the org's Daytona disk quota (30GiB) is shared; leaked sandboxes eventually block every new one, and a sandbox whose DO lost its runtime ref is orphaned and only clearable from the Daytona dashboard.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `GET /api/debug/tool-timing`          | `?threadId=`                                                        | `{ rows: [{ toolCallId, toolName, startedAt, finishedAt, ok, durationMs }] }` — per-call tool durations for the thread, newest start first, ALL tools including MCP. A row with `finishedAt: null` is still OPEN: either running now, or a call that never returned. The row is written BEFORE the call runs precisely so the second case leaves evidence — a completion-only record shows nothing at all for the failure worth investigating. Retained to the newest 500 rows per thread.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `GET /api/debug/work-ledger`          | `?threadId=`                                                        | `{ rows: WorkRow[] }` — the full `background_work` ledger for the thread, as-is (no filtering/pagination). Auditing classification accuracy is the point: read `outcome`/`reason`/`startedAt`/`lastAliveAt` on each row directly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `POST /api/debug/spawn-subagent`      | `{ threadId, task, label? }`                                        | `{ runId }` — dispatch a subagent directly (no model turn)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `GET /api/debug/subagent-state`       | `?threadId=`                                                        | `{ timings: {runId:{startedAt,finishedAt?}}, leases: [runId] }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `GET /api/debug/messages`             | `?threadId=&limit=`                                                 | `[{ role, text }]` — recent thread messages (read a subagent's injected completion)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `POST /api/debug/run-backstop`        | `{ threadId }`                                                      | `{ attached, watchers, runningProcesses }` — run the turn-end watcher backstop sweep (as `onChatResponse` does) and report what it attached + what the read-only UI callable now sees                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `GET /api/debug/raw-status`           | `?threadId=&processId=`                                             | raw Daytona command dump (`getSessionCommand` + the session's `commands[]`) — inspect the actual completion fields (e.g. why `exitCode` is/isn't populated)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `POST /api/debug/compact`             | `{ threadId }`                                                      | `{ provider, model, budget: {contextWindow, compactAfterTokens}, seeded: {messages, estimatedTokens}, compacted, outcome }` — seed enough synthetic history (sized from the thread's own resolved budget) to make a REAL compaction necessary, then force it through the same `session.compact()` path the manual "Compact thread" action uses, on the LIVE model/summarizer. `provider`/`model` are the RESOLVED values the thread actually ran on (its own override if `/thread` set one, else the agent's default) — check them at a glance against `budget` to confirm which model and window drove the run. No sandbox is provisioned. See below.                                                                                                                                                                                                                                                                          |

On a thrown error the handlers return JSON `{ error, detail?, stack? }` with a
500 (not a bare Worker 1101), so failures are diagnosable from the response.

## Common QA flows

Set up once:

```bash
TOKEN=<DEBUG_TOKEN>; BASE=https://<your-canonical-host>
TID=$(curl -s -X POST "$BASE/api/debug/thread" -H "x-debug-token: $TOKEN" -d '{}' | grep -o 'thr_[a-z0-9-]*')
```

**Verify a subagent captures its work output (R1 regression check):**

```bash
RUN=$(curl -s -X POST "$BASE/api/debug/spawn-subagent" -H "x-debug-token: $TOKEN" -H "content-type: application/json" \
  -d "{\"threadId\":\"$TID\",\"task\":\"Use exec, not exec_start. Run exactly: sleep 12 && echo QA_OK . If exec returns backgrounded, use exec_output until stdout is visible, then report the final stdout verbatim.\",\"label\":\"qa\"}" | grep -o 'sub_[a-z0-9-]*')
# poll subagent-state until finishedAt appears, then read the completion:
curl -s "$BASE/api/debug/subagent-state?threadId=$TID" -H "x-debug-token: $TOKEN"
curl -s "$BASE/api/debug/messages?threadId=$TID&limit=1" -H "x-debug-token: $TOKEN"   # expect QA_OK in the text
```

**Verify a long/silent subagent isn't abandoned (R2):** use a `sleep 100 && echo`
task; it should reach a `finishedAt` (~110s+) with real output, not stall.

**Reproduce background-exec output capture at the sandbox layer (no subagent):**

```bash
PID=$(curl -s -X POST "$BASE/api/debug/exec-start" -H "x-debug-token: $TOKEN" -H "content-type: application/json" \
  -d "{\"threadId\":\"$TID\",\"command\":\"sleep 15 && echo LATE\"}" | grep -o 'proc_[a-z0-9-]*')
# poll every few seconds — output appears at true completion (~15s):
curl -s "$BASE/api/debug/exec-output?threadId=$TID&processId=$PID" -H "x-debug-token: $TOKEN"
```

Note: `exec-output` reads the process status from the store, which only advances
when a watcher poll runs; a subagent path (or the turn-end backstop) drives that.

**Verify the turn-end watcher backstop end-to-end (no chat turn):**

```bash
PID=$(curl -s -X POST "$BASE/api/debug/exec-start" -H "x-debug-token: $TOKEN" -H "content-type: application/json" \
  -d "{\"threadId\":\"$TID\",\"command\":\"sleep 12 && echo REMINDER_TEST\"}" | grep -o 'proc_[a-z0-9-]*')
# run the backstop sweep exactly as onChatResponse does — expect attached:[PID], watchers:[{...}]:
curl -s -X POST "$BASE/api/debug/run-backstop" -H "x-debug-token: $TOKEN" -H "content-type: application/json" -d "{\"threadId\":\"$TID\"}"
sleep 25   # command (12s) + a watcher poll cycle (~7s)
curl -s "$BASE/api/debug/exec-output?threadId=$TID&processId=$PID" -H "x-debug-token: $TOKEN"   # status -> "exited", exitCode 0
curl -s "$BASE/api/debug/messages?threadId=$TID&limit=4" -H "x-debug-token: $TOKEN"             # expect the "exited with code 0" system-reminder + model reply
```

## Real compaction smoke (`/compact`)

Verifies token accounting for compaction against a live provider — the one
source not otherwise coverable, since the owner's own model window (1M →
694,400-token trigger) is too large to trip naturally. Resolves the thread's
context budget, appends ~60 synthetic messages sized so their combined
estimate clears `compactAfterTokens` by ~30% (derived from the budget, not a
flat count — a flat count would silently no-op on a huge-window model exactly
as it did in production), then calls the same `session.compact()` the manual
"Compact thread" RPC uses (real summarizer call, real ledger write in its
`finally`). Uses `addMessages` (durable append, no model turn) to seed, never
`saveMessages` (which runs a turn). Does not touch the sandbox — no
provisioning, no Daytona disk quota impact.

```bash
curl -s -X POST "$BASE/api/debug/compact" -H "x-debug-token: $TOKEN" \
  -H "content-type: application/json" -d "{\"threadId\":\"$TID\"}"
# then confirm the ledger + gauge:
curl -s "$BASE/api/debug/messages?threadId=$TID&limit=4" -H "x-debug-token: $TOKEN"   # expect a "Thread compacted" divider
# thread_token_usage should now have a `compaction`-source row for this thread,
# and thread_index.last_context_tokens should have FALLEN while a `chat` row's
# input_tokens on the NEXT turn RISES (query D1 directly for both).
```

**Run the smoke on a small model instead of the owner's default** (cheaper seed

- summarizer call — pass `provider`/`model` to `/thread`; both are required
  together, and an unsupported or unusable pair 400s immediately instead of
  failing mid-compaction):

```bash
TID=$(curl -s -X POST "$BASE/api/debug/thread" -H "x-debug-token: $TOKEN" -H "content-type: application/json" \
  -d '{"provider":"openai-oauth","model":"gpt-5.3-codex-spark"}' | grep -o 'thr_[a-z0-9-]*')
curl -s -X POST "$BASE/api/debug/compact" -H "x-debug-token: $TOKEN" \
  -H "content-type: application/json" -d "{\"threadId\":\"$TID\"}"
# response now includes {"provider":"openai-oauth","model":"gpt-5.3-codex-spark",...} —
# confirm at a glance it ran on the small model, and its (smaller) budget.
curl -s -X POST "$BASE/api/debug/shutdown" -H "x-debug-token: $TOKEN" \
  -H "content-type: application/json" -d "{\"threadId\":\"$TID\"}"
```

If `compacted: false`, `outcome.reason` says why (e.g. "history shorter than
the protected span" or "nothing between the protected head and tail") — read
it alongside `budget` and `seeded.estimatedTokens` to see whether the seed
undershot the trigger or the protected head/tail simply swallowed the whole
seed for that model's budget.

## Cloudflare compute smoke (`/cloudflare-compute`)

Builds a `CloudflareComputeBackend` **directly** (bindings + this thread's
`workspaceId`/`threadId` + `useLocalBucket:false`) — it does NOT read the
thread's configured provider, so it exercises the real Cloudflare container even
when the workspace runs on Daytona. It settles the claims no fake could:
readiness; fail-closed egress on a non-empty `allowedHosts` (throws
`policy_rejected` before any container is created); that the sandbox id is
`ws_<workspaceId>_<threadId>` and NOT derived from the constant
`environmentId="cloudflare:small"`; exec stdout/exit + stdin delivery; that
`/workspace` exists and is writable; a byte-for-byte file round-trip;
`movePath(overwrite)` over an existing destination **plus** the raw SDK
`moveFile` behavior we have never known (replace / error / `{success:false}`);
in-band `{success:false}` vs throw for delete/mkdir/write/restore; `FileInfo.type`
for a symlink (Cloudflare may report `"symlink"`, Daytona never does); a
recoverable release → restore round-trip with the current `spec.env` reapplied;
and the discard→fresh-empty-container divergence. `detail` records what actually
happened for each — read it, don't just check `ok`.

```bash
curl -s -X POST "$BASE/api/debug/cloudflare-compute" -H "x-debug-token: $TOKEN" \
  -H "content-type: application/json" -d "{\"threadId\":\"$TID\"}"
# if a run was interrupted before its self-clean, reclaim the container:
curl -s -X POST "$BASE/api/debug/cloudflare-shutdown" -H "x-debug-token: $TOKEN" \
  -H "content-type: application/json" -d "{\"threadId\":\"$TID\"}"
```

**Money + quota:** every run boots a real container. The orchestrator destroys it
in a `finally`, but the SDK cannot enumerate containers, so cleanup is by-id
best-effort; a failed self-clean is reported as a failed step. If in doubt, call
`/cloudflare-shutdown`. Never run this in a loop.

## Work-ledger live verification (`/sandbox-reset`, `/work-healthy`)

The reaper's two directions, against a real container. Neither is unit-testable:
`FakeComputeBackend` cannot OOM, and ~1300 green unit tests have coexisted with a
blind reaper, an inert nonce, a throttled alarm, and clean exits destined to
fault. These two endpoints are the verification worth trusting.

```bash
TOKEN=<DEBUG_TOKEN>; BASE=https://<your-canonical-host>
TID=$(curl -s -X POST "$BASE/api/debug/thread" -H "x-debug-token: $TOKEN" -d '{}' | grep -o 'thr_[a-z0-9-]*')

# Direction 1 — a reset IS detected and reported (~40-90s):
curl -s -X POST "$BASE/api/debug/sandbox-reset" -H "x-debug-token: $TOKEN" \
  -H "content-type: application/json" -d "{\"threadId\":\"$TID\"}"

# Direction 2 — a healthy long run is NOT faulted (~45s):
curl -s -X POST "$BASE/api/debug/work-healthy" -H "x-debug-token: $TOKEN" \
  -H "content-type: application/json" -d "{\"threadId\":\"$TID\"}"

# ALWAYS, even if a run failed — every debug thread holds a real container:
curl -s -X POST "$BASE/api/debug/shutdown" -H "x-debug-token: $TOKEN" \
  -H "content-type: application/json" -d "{\"threadId\":\"$TID\"}"
```

**`/sandbox-reset` flow.** Starts `sleep 300 && echo NEVER` and **arms a watcher**
(`execStart` alone attaches none — `execWatch` is what registers the ledger row
the reaper classifies), reads the persisted nonce, destroys the derived
`ws_<workspaceId>_<threadId>` container out of band (the `/cloudflare-shutdown`
path), then waits for the **watcher's own failing poll** to probe the container,
and up to 60s for the terminal + the delivered reminder. It reads the row's
terminal **and** the thread's messages — delivery is never inferred from the row,
which is written before the injection and survives a delivery that never
happened.

**Nothing re-provisions — do not expect it to.** An earlier version of this
section said `sandbox_reset` fires only when the DO re-provisions, and that a
bare `execStart` was the lever. The 2026-07-16 live run killed that: after
`.destroy()` the SDK silently hands back a **working** container on the same
sandbox id, so `execStart` never throws `SandboxNotFound`, `markRuntimeMissing`
never fires, and `readOrAcquireRuntime` early-returns on `status === "active"`.
Re-provision is not a lever we have.

What a real reset leaves is the **wiped filesystem**: the container answers and
its nonce is gone. The failing poll probes it, `readGeneration` returns `absent`,
and `restoreGenerationAfterWipe` writes a **fresh nonce to that same live
container** and persists it — all inside one probe call. So the normal reading is
`generationState: "known"` with a nonce that DIVERGED from `generationBefore`,
and the reset is detected on the `known` arm. `generationState: "absent"` means
the restore WRITE failed; that is still a genuine reset and still closes as
`sandbox_reset`, via the `absent` arm.

**`generationDiverged` (formerly `reprovisioned`) means "a nonce is on record
that is not the one this run started with" — nothing more.** It was renamed
because a divergence now normally comes from a restore, not a provision, and no
signal in the DO can witness a provision after the fact (the CF runtime ref is
deterministic). Read `resetPathExercised`, not just `reminderDelivered`: it keys
on `reason === "sandbox_reset"` and never on the probe, so a `no_liveness` result
is reported as the real finding it is, not dressed up as a pass.

- **PASS:** every step `ok`, `resetPathExercised: true`, `reason:
"sandbox_reset"`, `reminderDelivered: true` with `reminderText` saying the
  filesystem is gone, `terminalViaExplicitSweep: false`, `elapsedMs` in the
  seconds. Expect `generationDiverged: true` with `generationState: "known"` (the
  restore landed); `generationDiverged: false` with `generationState: "absent"`
  is ALSO a pass (the restore write failed, the `absent` arm caught it) — what
  fails is `generationState: "unknown"`.
- **FAIL / partial:** `reminderDelivered: false` — the row closed but the model
  was never told (the blackhole this work exists to kill).
  `terminalViaExplicitSweep: true` — classification works but the **alarm never
  fired**, so nothing would have swept it in production.
  `resetPathExercised: false` with `reason: "no_liveness"` — the reset path was
  **not** exercised; report it as that, not as a pass.

**`/work-healthy` flow.** Runs `sleep 30 && echo HEALTHY_DONE` watched, past the
21s stale window. PASS: `aliveAfterStaleWindow: true`, `stampAdvancedMs > 0` (the
watcher's polls actually stamped the row — an unstamped row is faulted
`no_liveness` at 21s, which is the false-fault mechanism), `outcome: "exited"` /
`reason: "process_exit"`, `faultDelivered: false`. Any `faultDelivered: true` is
a **false fault**: the model was told its files were gone while the work was fine.

**Money + quota:** every run of either endpoint boots a real container. Both
self-clean in a `finally` (`execShutdown`, then a by-id destroy), but the SDK
cannot enumerate containers, so cleanup is by-id best-effort and a failed
self-clean is reported as a failed step — read the `clean:` steps. If in doubt,
call `/cloudflare-shutdown`. **Never run either in a loop.**

## Gotchas

- **Daytona 30 GiB disk limit.** Provisioning fails with
  `SandboxProvisionError` / `detail: "Total disk limit exceeded"` when stale
  sandboxes fill the quota. Clear unused sandboxes in the Daytona dashboard;
  the app's provider wrapper has no bulk-list/delete.
- **Deploys reset DO isolates** — a subagent spawned in the same breath as a
  `pnpm run deploy` can come back `interrupted`. Deploy first, then drive.
- **Debug `/exec-start` is intentionally async:** it bypasses the model-facing
  sync-first `exec` tool so diagnostics can create a known background process.
  A command's real exit is observed later via `getProcessStatus`, and its output
  is available at true completion (see the R1 fix in
  `src/sandbox/providers/daytona.ts`). Model/subagent prompts should say `exec`,
  not `exec_start`.
- **`exec-output` status is STALE without a watcher.** It refreshes _output_ but
  returns the _stored_ status, which only flips to `exited` when something polls
  `getProcessStatus` — i.e. an attached watcher (or `run-backstop`). A bare
  `exec-start` you never watch stays `"running"` forever in the store even though
  Daytona has the real `exitCode`. Don't mistake that stale status for "Daytona
  never reports exit" — confirm with `raw-status` (it shows the true `exitCode`).
- **A slow tool call is diagnosed from `/tool-timing`, not from the transcript.**
  The transcript shows an unresolved tool call with no start time, so a turn cut
  mid-call is indistinguishable from one that was merely slow. `finishedAt:
null` on an old `startedAt` is the signal. Durations also render in the web
  transcript (stamped onto the message part), but only above 1s and only for
  calls that finished — the open ones exist here and nowhere else.
- These endpoints ship gated in prod as dev tooling; do not remove the
  `DEBUG_TOKEN` gate.
