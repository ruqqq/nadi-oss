# P4 — Agent Surfaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the agent+workbench merge's user-facing surfaces: make the workspace skill library visible and opt-out-able on each agent, let a skill move between scopes, and make a deleted or disabled agent's threads read as read-only rather than failing at send.

**Architecture:** Backend-first. The two-scope skills data model, resolution and exclusion storage all shipped in P2 (`skills.agent_id` nullable, `agent_skill_exclusions`, `AgentSkillRepository.listEffective` / `excludeLibrarySkill` / `includeLibrarySkill` / `listExcludedSkillIds`). Nothing reads them over HTTP and no UI shows them. P4 adds the HTTP surface, the scope-move operations, the two-group agent Skills view, and the read-only thread affordance.

**Tech Stack:** Cloudflare Workers, D1 + drizzle, React 19, shadcn/ui + AI Elements, Tailwind v4, Phosphor icons, MSW mocks, Vitest (six projects).

**Spec:** `docs/superpowers/specs/2026-08-30-agent-workbench-merge-design.md` in the OVERLAY repo (`/home/exedev/work/nadi`) — sections "Surfaces", "Skills have two scopes", "Deleting an agent". Note this plan lives in the oss repo rather than beside its siblings in the overlay: a worktree-isolated session cannot write to the overlay checkout, and the plan ships on the same branch as the code it describes.

## What P4 is NOT — verified already shipped, do not rebuild

Verified against the source on 2026-09-01. If you find any of these claims false,
say so with evidence and stop; the task list assumes them.

| Spec item | Where it already lives |
| --- | --- |
| Settings tab list `general · agents · providers · sandbox · connections · tools · skills`; `memory` and `workbenches` retired | `web/src/Settings.tsx:262-338` |
| Routed drill-down `/settings/agents/<agentId>` + `new`, one-back depth stamp | `web/src/lib/settings-routes.ts:55-65` |
| All eight agent sections (Instructions · Model & reasoning · Sandbox · Repositories · Secrets & env vars · Skills · Memory · Danger zone) | `web/src/settings/AgentsSection.tsx` |
| Agent creation UI + `POST /api/agents` | `AgentsSection.tsx:257`, `src/http/agent-routes.ts:88` |
| Per-agent memories, incl. archive-with-agent | `web/src/settings/MemorySection.tsx`, `src/http/memory-routes.ts`, `src/db/repositories/agents.ts:140` |
| Agent picker beside the project picker in the composer | `web/src/App.tsx:4173-4187` |
| Turn refusal for archived/disabled agents, read live from D1 | `src/agent/think-thread-agent.ts:2252-2273` |
| Disable copy ("Turn this off to stop the agent from running") is now TRUE | `src/compute/config.ts:146-167` — P3 fixed the `enabled`/`sandbox_enabled` confusion |

**Ruling — `recoveryTtlMs` settings copy is dropped from P4.** The P3 ledger carried
"settings-UI copy for the inert `recoveryTtlMs` on sprites". There is no user-facing
form field for it: it exists on the wire (`web/src/sandbox-settings-api.ts:47`) and as
a default (`SandboxSection.tsx:80`), and is never rendered. There is nothing to
relabel. Cost if wrong: a hidden field stays undocumented, which is the status quo.

## Global Constraints

- **Ships BIG BANG.** No flags, no dual paths, no adapters. The path you add deletes the one it replaces. Phases are commit boundaries, not releases.
- **Treat this plan as UNTRUSTED.** Verify every claim against the source. A finding that contradicts this plan is worth more than compliance with it. Thirteen premises have been overturned this way on this branch.
- **Demand that every guard be PROVEN to fire.** Mutate it and watch the test go red. A test that has never failed proves nothing. State in your report exactly what you mutated.
- **Carry the reason next door.** When a fix or a guard lands at one call site, grep every sibling and state in your report which siblings you checked and why they do or do not need it. The dominant defect of P3 was a right idea applied to one site and not its neighbour.
- **Changing an API contract means updating the mocked app in the SAME change.** New/changed `/api/*` route → handler in `web/src/mocks/rest/`; new payload field → `web/src/mocks/store.ts` and the `make*` helpers in `web/src/mocks/scenarios/index.ts`. An optional field added to a mock silently is exactly how the two Workbenches wire-contract regressions shipped.
- **A stale client must not be able to bypass a gate.** Enforce at the data source, reading the row, never in cached bootstrap.
- **Two adjacent versions must accept each other's payloads.** A newly-*required* field on a wire payload has to land in two releases. Adding an OPTIONAL field the client tolerates as absent is safe; make the client tolerate it.
- `exactOptionalPropertyTypes` is on — `{ x: undefined }` is not assignable to `x?: string`.
- `pnpm run fmt` does NOT cover `web/`. The enforced web gate is `oxlint` + `pnpm run web:typecheck`.
- **Do NOT run `pnpm run check` or a bare `pnpm test`** — they OOM this ~3.8GB box. Six vitest projects: `unit`, `web-unit`, `integration-fast`, `integration-grouped`, `integration-shared`, `integration-isolated`. While iterating, run only the projects whose globs cover your changed files; mutation proofs run the SINGLE test file. Run all six ONCE, as a single invocation, immediately before your commit.
- **There is no exhaustive-deps lint in this repo.** A `useCallback` with a `[]` dep array that closes over a prop is a live stale-closure bug — "breaks only on the first try" is its signature. Task 3 fixes one that exists today.
- Icons come from `web/src/icons.tsx`, never from `@phosphor-icons/react`. Semantic Tailwind utilities only (`bg-card`, `text-muted-foreground`), never hardcoded hex. Style and verify both themes.
- Errors surface through `errorFromResponse` (`web/src/lib/http-error.ts`) — a human-readable message, never a raw status code.
- Settings UI is built on the `section-ui` primitives (`SectionHeading`, `FormCard`, `Field`, `FormActions`, `PaneFooter`). Match the Dispatch language; do not invent parallel styling.
- Integration tests: every `it()` gets its own storage snapshot; `beforeAll` row writes do NOT reach tests; `integration-fast` runs `isolate: false`, so use explicit per-`it()` agent AND thread ids.
- **`seedRegistryThread` defaults every test to one agent**, which since P3 means one shared `AgentSandbox` DO. If a new integration test behaves strangely across files, pass an explicit `agentId` before blaming the environment.

## File Structure

**Backend**
- Modify `src/db/repositories/agent-skills.ts` — add `listLibraryForAgent`, `countAgentsLiveOn`, `moveToLibrary`, `copyToAgent`.
- Modify `src/http/skill-routes.ts` — add the agent-scoped listing, the exclusion route, and the two scope-move routes.
- Modify `src/http/thread-serialize.ts` — `readOnly` accounts for agent state; add `readOnlyReason`.

**Web**
- Modify `web/src/skills-api.ts` — the new calls and their types.
- Create `web/src/settings/AgentSkillsSection.tsx` — the two-group agent view.
- Modify `web/src/settings/SkillsSection.tsx` — library view keeps its job, gains the live-on count, loses the stale-closure bug.
- Modify `web/src/settings/AgentsSection.tsx` — render `AgentSkillsSection`; sandbox copy.
- Modify `web/src/threads-api.ts`, the thread view, `web/src/mocks/rest/*`, `web/src/mocks/scenarios/index.ts`.

---

### Task 1: The library, visible on an agent, with an opt-out

**Files:**
- Modify: `src/db/repositories/agent-skills.ts`
- Modify: `src/http/skill-routes.ts`
- Test: `test/integration/skill-scopes.integration.test.ts` (repository, two-scope behaviour) — extend it, do not create a second suite
- Test: `test/integration/skill-routes.integration.test.ts`

**Interfaces:**
- Consumes: `AgentSkillRepository.listActive`, `listEffective`, `excludeLibrarySkill`, `includeLibrarySkill`, `listExcludedSkillIds` (all exist); `resolveAgentScopeById` from `src/http/agent-scope.ts`.
- Produces:
  - `repo.listLibraryForAgent({ workspaceId, agentId }): Promise<LibrarySkillForAgent[]>` where `LibrarySkillForAgent = Skill & { excluded: boolean; shadowedByOwnSkillId: string | null }`
  - `GET /api/agents/:agentId/skills` → `{ library: LibrarySkillForAgent[], own: Skill[] }`
  - `POST /api/agents/:agentId/skills/:skillId/exclusion` body `{ excluded: boolean }` → `204`

**Why this shape:** `listEffective` already returns the post-exclusion, post-shadow
result — what the model gets at turn time. The UI needs the opposite: everything in
the library, each annotated with *why* it is or is not live here. Reusing
`listEffective` would render a list from which excluded skills have already
vanished, and the toggle would have nothing to turn back on.

- [ ] **Step 1: Write the failing repository test**

```ts
it("annotates a library skill excluded for this agent", async () => {
  const lib = await repo.create({ workspaceId: WS, agentId: null, name: "deploy", ... });
  await repo.excludeLibrarySkill({ agentId: AGENT_A, skillId: lib.id });

  const forA = await repo.listLibraryForAgent({ workspaceId: WS, agentId: AGENT_A });
  const forB = await repo.listLibraryForAgent({ workspaceId: WS, agentId: AGENT_B });

  expect(forA.map((s) => [s.name, s.excluded])).toEqual([["deploy", true]]);
  expect(forB.map((s) => [s.name, s.excluded])).toEqual([["deploy", false]]);
});

it("marks a library skill shadowed by the agent's own skill of the same name", async () => {
  const lib = await repo.create({ workspaceId: WS, agentId: null, name: "deploy", ... });
  const own = await repo.create({ workspaceId: WS, agentId: AGENT_A, name: "deploy", ... });

  const [row] = await repo.listLibraryForAgent({ workspaceId: WS, agentId: AGENT_A });
  expect(row.shadowedByOwnSkillId).toBe(own.id);
  expect(row.excluded).toBe(false); // shadowing is not exclusion — they are different states
});
```

- [ ] **Step 2: Run them and watch them fail**

Run that single integration file (project `integration-fast` unless its glob says otherwise — check `vitest.config.ts`). Expected: FAIL — `repo.listLibraryForAgent is not a function`.

- [ ] **Step 3: Implement `listLibraryForAgent`**

Reuse the existing `exclusion` and `shadowing` aliases at the bottom of the file
(`agent-skills.ts:503-505`) rather than declaring new ones. Left-join the exclusion
table on `(agent_id = :agentId AND skill_id = skills.id)` and the shadowing alias on
`(workspace_id, agent_id = :agentId, name = skills.name, archived_at IS NULL)`.
Filter to `skills.agent_id IS NULL AND skills.archived_at IS NULL`.

- [ ] **Step 4: Run the tests and watch them pass**

- [ ] **Step 5: Write the failing route tests, including the cross-workspace guard**

The exclusion route takes a `skillId` from the URL. It MUST refuse a skill that is
not a library skill in the caller's own workspace — otherwise a guessed id writes an
`agent_skill_exclusions` row across a workspace boundary. Assert all three refusals:

```ts
it("refuses to exclude a skill from another workspace", async () => { /* expect 404 */ });
it("refuses to exclude an agent-private skill", async () => { /* expect 404 — private skills are archived, not excluded */ });
it("refuses an agentId the session does not own", async () => { /* expect 404 */ });
```

- [ ] **Step 6: Run them, watch them fail (404 route not found)**

- [ ] **Step 7: Implement both routes in `src/http/skill-routes.ts`**

Follow the existing handler shape exactly: `validateRequestSession` → resolve scope
via `resolveAgentScopeById` → 404 on a null scope → repository call → `Response.json`.
Reuse the existing `serialize()` and extend it for the two annotation fields rather
than writing a second serializer.

- [ ] **Step 8: Prove the guard fires**

Delete the workspace check from the exclusion route and re-run the single route test
file. The cross-workspace test MUST go red. Restore it. **State in your report what
you mutated and which test died** — a guard that fails no test when removed is not a
guard.

- [ ] **Step 9: Run every project that covers your changes, then commit**

```bash
git add -A && git commit -m "feat: expose the workspace skill library on each agent"
```

---

### Task 2: Live-on counts, and moving a skill between scopes

**Files:**
- Modify: `src/db/repositories/agent-skills.ts`
- Modify: `src/http/skill-routes.ts`
- Test: the repository and route suites from Task 1

**Interfaces:**
- Consumes: Task 1's `listLibraryForAgent`.
- Produces:
  - `repo.countAgentsLiveOn(skillIds: string[]): Promise<Map<string, number>>`
  - `GET /api/skills` (library scope only) — each row gains `liveOnAgentCount: number`
  - `POST /api/skills/:id/move-to-library` → `{ skill }`
  - `POST /api/skills/:id/copy-to-agent` body `{ agentId }` → `{ skill }`

**Why:** the spec makes the count load-bearing — "each skill states **how many agents
it is live on** before you edit it. One copy means one edit reaches everywhere — that
is the feature and the hazard, and the count is what makes the blast radius visible at
the moment of editing."

**Ruling — what "live on" counts.** Unarchived agents in the workspace, minus those
that excluded the skill, minus those whose own active skill shadows it by name.
A *disabled* agent is counted: it still carries the skill and recovers fully on
re-enable, and a count that dropped when an agent was paused would understate the
blast radius. Cost if wrong: the number reads high by the count of paused agents.

- [ ] **Step 1: Write the failing count test**

```ts
it("counts agents the library skill is live on, excluding opt-outs and shadows", async () => {
  const lib = await repo.create({ workspaceId: WS, agentId: null, name: "deploy", ... });
  // AGENT_A: plain. AGENT_B: excluded. AGENT_C: shadows it. AGENT_D: disabled but live.
  await repo.excludeLibrarySkill({ agentId: AGENT_B, skillId: lib.id });
  await repo.create({ workspaceId: WS, agentId: AGENT_C, name: "deploy", ... });
  expect((await repo.countAgentsLiveOn([lib.id])).get(lib.id)).toBe(2); // A and D
});
```

- [ ] **Step 2: Run it, watch it fail**

- [ ] **Step 3: Implement `countAgentsLiveOn` and thread it through the list route**

Take the ids as a batch and return a map. Do NOT issue one query per skill in a loop —
group in a single statement keyed by `skill_id`. Return `liveOnAgentCount` only on
library-scope listings; an agent-private skill is live on exactly one agent and the
field would be noise.

- [ ] **Step 4: Run it, watch it pass**

- [ ] **Step 5: Write the failing move/copy tests**

The traps to assert, each as its own `it()`:

```ts
it("moving to the library carries the skill's script resource", async () => { ... });
it("copying to an agent creates NEW resource rows, not shared ones", async () => {
  // Editing the copy's script must not edit the original's.
});
it("refuses a move when an active library skill already has that name", async () => { /* 409 */ });
it("refuses a copy when that agent already has an active skill of that name", async () => { /* 409 */ });
it("moving to the library does not silently un-shadow: agents with their own copy keep theirs", async () => { ... });
it("drops exclusions pointing at a skill that leaves the library", async () => {
  // A skill moved out of library scope otherwise leaves orphan exclusion rows behind.
});
```

- [ ] **Step 6: Run them, watch them fail**

- [ ] **Step 7: Implement `moveToLibrary` and `copyToAgent`**

`moveToLibrary` sets `agent_id = NULL` on the existing row — the id, its resources and
its network domains all travel with it, which is the point ("it should not require
retyping it"). `copyToAgent` inserts a NEW skill row with a fresh id and inserts fresh
`agent_skill_resources` rows; it never re-points the originals. Both check the
active-name uniqueness of the DESTINATION scope first and throw
`AgentSkillDuplicateError`, which the routes turn into a 409 with a human-readable
body — the same shape `restore` already uses at `skill-routes.ts:125-128`.

- [ ] **Step 8: Run them, watch them pass; then mutate**

Remove the resource-copy from `copyToAgent` and confirm the "NEW resource rows" test
goes red. Restore. Report it.

- [ ] **Step 9: Update the mocks in this same commit**

`web/src/mocks/rest/` — the new routes, and `liveOnAgentCount` on the seeded library
skills. A mock that omits an optional field renders a state the real app can no longer
produce.

- [ ] **Step 10: All six projects in one invocation, then commit**

```bash
git commit -m "feat: move a skill between the library and an agent"
```

---

### Task 3: The two-group Skills surfaces

**Files:**
- Create: `web/src/settings/AgentSkillsSection.tsx`
- Create: `web/src/settings/AgentSkillsSection.test.tsx`
- Modify: `web/src/settings/SkillsSection.tsx`
- Modify: `web/src/skills-api.ts`
- Modify: `web/src/settings/AgentsSection.tsx` (render the new section in the Knowledge band)
- Modify: `web/src/mocks/scenarios/index.ts`

**Interfaces:**
- Consumes: Task 1's `GET /api/agents/:agentId/skills` and exclusion route; Task 2's `liveOnAgentCount`, move and copy routes.
- Produces: `<AgentSkillsSection agentId={string} />`.

**Design direction.** This is not a new visual language — it is the Dispatch system
already in `section-ui`. The one design decision worth making deliberately is how a
row states its provenance, because that is the whole feature: a reader must be able to
tell at a glance *why* a skill is here and *what editing it will touch*. Group with a
small uppercase eyebrow (`From the workspace library` / `This agent's skills`), reuse
the existing `SkillRow` card rather than a parallel row component, and let the row's
own trailing controls carry the state:

- A library row's Switch means **included here**, not `skill.enabled` — turning it off
  writes an exclusion. Label it so a screen reader says which:
  `aria-label={excluded ? "Use <name> on this agent" : "Exclude <name> from this agent"}`.
- A **shadowed** library row is inert: no switch, a muted line reading
  `Shadowed by this agent's own <name>` — specific beats general, no error, no
  ambiguity. Do not gray it into invisibility; the reader needs to know it exists.
- The move gestures are secondary actions, not primary buttons: `Move to library` on
  an own skill, `Copy to this agent` on a library one.

- [ ] **Step 1: Write the failing component tests**

```tsx
it("turning off a library skill excludes it for this agent", async () => {
  // renders both groups from a mocked GET; clicking the switch POSTs { excluded: true }
});
it("shows a shadowed library skill as inert, naming the agent skill that wins", async () => {
  expect(screen.getByText(/Shadowed by this agent's own deploy/)).toBeInTheDocument();
  expect(screen.queryByRole("switch", { name: /deploy/ })).not.toBeInTheDocument();
});
it("archiving from an agent page archives the AGENT's skill, not the library's", async () => {
  // The stale-closure regression, asserted directly. See Step 3.
});
```

- [ ] **Step 2: Run them, watch them fail**

Run the single web-unit file.

- [ ] **Step 3: Fix the live stale-closure bug in `SkillsSection.tsx`**

`onToggle`, `onArchive` and `onRestore` (`SkillsSection.tsx:43-75`) each close over
`agentId` and each declares `[]` as its dependency array. There is no exhaustive-deps
lint in this repo to catch it. Today the component happens to be remounted per agent,
so it is latent; a switch between two agents without a remount sends the write to the
scope captured on first render — archiving a library skill while looking at an agent's
page. Add `agentId` to all three, and keep the regression test from Step 1.

**Prove it:** revert the dep arrays to `[]` and confirm that test goes red. Report it.

- [ ] **Step 4: Build `AgentSkillsSection`**

- [ ] **Step 5: Add the live-on count to the library view**

One line under the skill's description in `SkillsSection`, library scope only:
`Live on 4 agents` / `Live on 1 agent` / `Not live on any agent` — the last is a real
state (every agent excluded it) and must not render as `Live on 0 agents`.

- [ ] **Step 6: Run web-unit and `pnpm run web:typecheck` + `oxlint`**

- [ ] **Step 7: Seed a scenario that reaches every state**

`web/src/mocks/scenarios/index.ts`: at least one plain library skill, one excluded,
one shadowed, one agent-private skill, and a library skill live on zero agents. Prefer
seeding a scenario over adding a `preview.tsx` screen.

- [ ] **Step 8: All six projects in one invocation, then commit**

```bash
git commit -m "feat: show the workspace library on an agent's skills page"
```

---

### Task 4: A deleted or disabled agent's threads read as read-only

**Files:**
- Modify: `src/http/thread-serialize.ts:123`
- Modify: `web/src/threads-api.ts`, `web/src/thread-runtime-routing.ts`, the composer's gate in `web/src/App.tsx`
- Modify: `web/src/mocks/rest/threads.ts`, `web/src/mocks/scenarios/index.ts`
- Test: the thread-serialize unit suite; a web-unit test for the notice

**Interfaces:**
- Produces: `readOnlyReason?: "thread_archived" | "legacy_runtime" | "agent_deleted" | "agent_disabled"` on the serialized thread. **Optional on the wire** — a stale tab holding a payload without it must still render.

**Why:** the send path already refuses correctly and with a human-readable message
(`think-thread-agent.ts:2252-2273`), and `AgentSandbox.acquire` refuses too. What is
missing is that `readOnly` (`thread-serialize.ts:123`) is computed from
`runtime === "legacy" || archivedAt != null` and knows nothing about the agent. So the
composer renders normally and the user discovers the refusal by typing a message and
watching it bounce. The spec: "The thread view shows why it is read-only rather than
failing silently."

**This does not replace the server gate.** The client affordance is an explanation, not
an enforcement point — the two gates stay exactly as they are. If your change makes the
server-side refusal reachable only through the UI, you have broken the invariant.

- [ ] **Step 1: Write the failing serializer test**

```ts
it("marks a thread read-only when its agent is archived", () => {
  expect(serializeThread({ ...base, agentArchivedAt: 123 })).toMatchObject({
    readOnly: true,
    readOnlyReason: "agent_deleted",
  });
});
it("marks a thread read-only when its agent is disabled", () => { /* "agent_disabled" */ });
it("keeps the archived-thread reason when both are true", () => {
  // The thread's own state is the more specific fact; assert the precedence you chose.
});
```

- [ ] **Step 2: Run it, watch it fail**

- [ ] **Step 3: Find where the serializer's input is built and carry the agent state to it**

`serializeThread` is a pure function over an input object; the agent's `archived_at`
and `enabled` have to reach it from the query that builds that input. **Grep every
call site** and state in your report which ones you changed and which already had the
columns. A call site left un-updated is the exact defect shape this branch keeps
producing.

- [ ] **Step 4: Run it, watch it pass**

- [ ] **Step 5: Render the reason**

Where the composer is currently suppressed for an archived thread, show the reason
instead of nothing. Copy, in the interface's voice — it explains and points at the
fix, it does not apologize:

- `agent_deleted` → "This chat's agent was deleted. The chat stays here to read."
- `agent_disabled` → "This chat's agent is turned off. Turn it back on in Settings → Agents to keep working here."

An unknown or absent `readOnlyReason` falls back to today's wording. Do not switch on
it exhaustively without a default — a stale client will send you `undefined`.

- [ ] **Step 6: Seed a scenario for both states and drive it**

- [ ] **Step 7: All six projects in one invocation, then commit**

```bash
git commit -m "feat: say why a chat is read-only when its agent is gone"
```

---

### Task 5: When a sandbox setting takes effect

**Files:**
- Modify: `web/src/settings/AgentsSection.tsx:335-375`
- Test: `web/src/settings/AgentsSection.test.tsx`

**The task is to find the truth first, then write it.** The claim to check: a change to
**Machine size** (`resourceProfile`) or **Allowed domains**
(`networkDomainAllowlist`) does not reach a box that is already running — it applies
when the agent's machine is next created. Prior art says the allowlist is applied at
CREATION only on Daytona. Verify BOTH fields against the current source for the sprites
path as well; P3 rewrote acquisition.

**If the claim is false for a field, write what is true instead.** Do not paste the
sentence onto a field that does pick the change up live — that would be a worse lie
than the silence it replaces.

- [ ] **Step 1: Verify, and write down what you found**

Trace `resourceProfile` and the allowlist from `agents` through
`resolveEffectiveComputeConfig` to the provider call, for sprites specifically. Record
the file:line evidence for each in your report.

- [ ] **Step 2: Write the hint copy as a test assertion first**

```tsx
it("says when a machine-size change takes effect", () => {
  render(<AgentDetailPage agent={AGENT} ... />);
  expect(screen.getByText(/next time this agent's machine is created/i)).toBeInTheDocument();
});
```

- [ ] **Step 3: Run it, watch it fail**

- [ ] **Step 4: Add the hint to the `Field`'s existing `hint` prop**

Both fields already take a `hint`; extend the existing sentence rather than adding a
second paragraph. Keep it to one clause: what the control does, then when it lands.

- [ ] **Step 5: Run web-unit, `web:typecheck`, `oxlint`**

- [ ] **Step 6: All six projects in one invocation, then commit**

```bash
git commit -m "feat: say when a sandbox setting reaches the machine"
```

---

## Release-gate additions

Append to the P3 smoke list in
`.superpowers/sdd/2026-08-31-p3-agent-scoped-persistent-sandbox/task-5-report.md`:

12. **Exclusion round trip on a live agent** — exclude a library skill, start a turn,
    confirm the model does not load it; re-include, confirm it comes back. The
    resolution path is `listEffective`, which no UI has ever driven.
13. **A moved skill's script still runs.** `run_skill_script` resolves resources by
    `skill_id`; a move keeps the id and a copy makes new rows. Only a live run proves
    the copy's resources are reachable.
