# Subagent live-smoke checklist

Status: **PENDING** — not yet run. Run this against a deployed environment with
real Daytona after the shared-sandbox subagents feature is deployed.

The facet dispatch + notify + cross-DO shared-machine + auth-routing layer is
verified against a DEPLOYED environment with real Daytona, because it needs
real facet routing and real provisioning that the test pool cannot provide.
Deterministic in-pool coverage of everything else lands in Tasks 1–5, 6 (via
the `SUB_AGENT` test binding + `_testSubagentContext` seam), 7–9, and 10a
(`test/unit/sandbox/thread-service-attached.test.ts`).

## Steps

1. [ ] Deploy; open a real thread on an agent with sandbox enabled.
2. [ ] Have the parent create a marker file (e.g. `echo hi > /tmp/marker` via `exec`).
3. [ ] Model calls `spawn_subagent` with a task to `cat /tmp/marker`; confirm the tool returns `{ runId, status: "started" }` immediately (parent keeps control).
4. [ ] Confirm the subagent reads the SAME file (shared machine) — its result contains the marker contents.
5. [ ] Confirm a completion message (`formatDetachedCompletion`) is injected into the PARENT chat when the child finishes.
6. [ ] Confirm the parent's active-child lease clears after completion (sandbox becomes idle-evictable again).
7. [ ] Confirm depth-1: the subagent has no `spawn_subagent` tool.
8. [ ] Confirm the concurrency cap: spawning a 5th concurrent child returns the "wait" rejection.
9. [ ] Confirm `onBeforeSubAgent` 404s a guessed child run id via the drill-in route.
10. [ ] Run a subagent long enough that the parent thread goes idle (or is evicted+rehydrated) mid-run; confirm the shared Daytona machine is NOT deleted while the child is still running, and IS reaped only after the child finishes.

## Result

Fill in after running: pass/fail per step, date, deployment SHA, notes.

## Phase 2 — visibility & control (deployed)

1. [ ] **Run card appears.** In a think thread, ask the agent to `spawn_subagent`
       with a labeled task (e.g. "Sleep 30s then echo done", label "Sleep test").
       A card replaces the `spawn_subagent` tool strip: title = the label, a
       spinner + "Running" badge, and a "· working" progress line.
2. [ ] **Live progress + elapsed.** The elapsed label advances each second while
       running.
3. [ ] **Drill-in.** Tap the card → the Sheet/Dialog opens and streams the child's
       transcript (text + any tool calls).
4. [ ] **Cancel.** While a longer child runs (e.g. "Sleep 300s"), open the card and
       click "Cancel run". Verify in `wrangler tail`: `onAgentToolFinish` fires with
       `status: "aborted"` and the lease is released; the child stops; the card
       badge flips to "Cancelled". No orphaned Daytona machine.
5. [ ] **Completion notice.** When a child finishes, the completion renders as the
       distinct `SubagentResultNotice` (labeled, status-colored) — NOT a raw
       right-aligned bubble with `<system-reminder>` text.
6. [ ] **Clear finished.** With ≥1 terminal run, "Clear finished subagents" appears;
       clicking it removes the terminal cards.

---

## Reliability & UX pass (2026-07-06) — verification matrix

Fixes: R1 lost/empty results, R2 90s give-up, U1 duration-after-refresh,
U2 redundant package tool, U3 live status/UI. Design/plan under
`docs/superpowers/specs|plans/2026-07-06-subagents-reliability-ux*`.

### R1 root cause (CONFIRMED live)

`executeSessionCommand(runAsync:true)` returns an immediate launch ack whose
`exitCode` is defined — so `startProcess` marked a still-running process
`exited` at t≈0. A watcher's single output read then landed before the command
produced anything, and the real output was lost (reported as an empty
"completed"). NOT an output-capture lag: raw `getSessionCommandLogs`
instrumentation showed `stdout` appears exactly at true completion. Fix:
an async launch is always `running`; the true exit comes via `getProcessStatus`.

### Debug-endpoint harness (DEBUG_TOKEN-gated, `/api/debug/*`)

Used to reproduce/verify without the UI (see `src/http/debug-routes.ts`):
`POST /thread`, `POST /exec-start`, `GET /exec-output`, `POST /spawn-subagent`,
`GET /subagent-state`, `GET /messages`. Header: `x-debug-token: <DEBUG_TOKEN>`.

- [x] **R1 verified.** `spawn-subagent` with task "run `sleep 10 && echo X`
      with exec; if it backgrounds, use the returned `watching` status and
      follow up with exec_output until stdout is available" → completion message
      contains the real `X` output (was empty "completed" before the fix).
- [x] **R2 long-run VERIFIED.** A subagent silent ~116s (`sleep 100 && echo`
      launched with exec, then followed through its backgrounded/watching
      status) ran to its real terminal and captured `R2_SURVIVED` — NOT
      abandoned at 90s. Bounded only by the 45m `maxBudgetMs`.
- [ ] **U1 duration after refresh.** Reload mid-run → the run card's elapsed
      time is accurate (server `startedAt`), not reset to ~0.
- [x] **U2 no package tool** (unit-verified: `createSandboxTools` omits it when
      `attachedSandboxId` is set; subagents run attached).
- [ ] **Terminal states.** Successful, failed, and canceled subagent runs each
      render a distinct, truthful terminal (no empty "completed").
