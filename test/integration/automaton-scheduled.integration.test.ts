/**
 * `fireDueAutomata` orchestrates the whole scheduler: claim, agent lookup,
 * thread creation, DO dispatch, skip bookkeeping, and the reaper — all of it
 * previously untested against real D1 (only `decideDueAction`, a pure
 * function, had unit coverage). These tests exercise the orchestration
 * end-to-end, the same way the `* * * * *` cron tick calls it in
 * `src/index.ts`'s `scheduled()` handler.
 *
 * A trigger note on case 1 (wedge recovery): the task brief suggested
 * pointing an automaton at a nonexistent `agent_id` to force a post-claim
 * failure. That is not reachable here — `automata.agent_id` carries a real
 * FK to `agents.id` and D1 enforces it (verified directly: both an insert
 * with a dangling agent_id and a delete of a referenced agent throw
 * "FOREIGN KEY constraint failed"). Instead these tests point the automaton
 * at a `project_id` that doesn't exist. `thread_index.project_id` has no FK,
 * so the row inserts cleanly, but `ProjectRepository.assertProjectInWorkspace`
 * throws `project_not_found` from inside `startAutomatonRun`, while resolving
 * the thread's `environmentId` from the project's default environment — a
 * genuine failure that lands after the claim
 * and before the DO is ever touched. Same code path (the
 * `AutomatonRunFailedAfterClaim` branch in `fireDueAutomata`), same
 * observable contract, no FK fight.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../../src/db/schema";
import type { AutomatonRunStatus, AutomatonRunTrigger } from "../../src/db/schema";
import {
  AUTOMATON_FIRE_BATCH,
  AUTOMATON_GRACE_MS,
  AUTOMATON_RUNNING_TIMEOUT_MS,
  fireDueAutomata,
} from "../../src/automata/fire-due";
import { computeNextDueAt, parseSchedule } from "../../src/automata/schedule";
import { AutomatonRepository } from "../../src/db/repositories/automata";
import { AgentRepository } from "../../src/db/repositories/agents";
import { log } from "../../src/log";

const WORKSPACE_ID = "ws_sched";
const USER_ID = "usr_sched";
const AGENT_ID = "agt_sched";
const DAILY_SCHEDULE_JSON = '{"kind":"daily","hour":8,"minute":0}';

function db() {
  return drizzle(env.REGISTRY_DB, { schema });
}

async function seedWorkspace() {
  const now = Date.now();
  await env.REGISTRY_DB.prepare(
    "INSERT OR IGNORE INTO workspaces (id, name, created_at) VALUES (?, ?, ?)",
  )
    .bind(WORKSPACE_ID, "Scheduler", now)
    .run();
  await env.REGISTRY_DB.prepare(
    "INSERT OR IGNORE INTO users (id, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(USER_ID, "scheduler@example.com", 1, now, now)
    .run();
  await env.REGISTRY_DB.prepare(
    "INSERT OR IGNORE INTO agents (id, workspace_id, name, system_prompt, provider, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(AGENT_ID, WORKSPACE_ID, "Agent", "", "mock", "mock", now)
    .run();
}

type AutomatonInput = {
  id: string;
  nextDueAt: number | null;
  projectId?: string | null;
  agentId?: string | null;
  scheduleJson?: string;
  timezone?: string;
  enabled?: boolean;
  modelProvider?: string | null;
  model?: string | null;
  modelInputModalities?: string | null;
};

function prepareAutomaton(input: AutomatonInput, now = Date.now()) {
  return env.REGISTRY_DB.prepare(
    "INSERT INTO automata (id, workspace_id, owner_user_id, agent_id, project_id, name, prompt, model_provider, model, model_input_modalities, schedule_json, timezone, enabled, next_due_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    input.id,
    WORKSPACE_ID,
    USER_ID,
    // The agent IS the environment: an `agentId` on the input names the
    // agent this automaton's runs execute as.
    input.agentId ?? AGENT_ID,
    input.projectId ?? null,
    "Test Automaton",
    "Do the thing.",
    input.modelProvider ?? null,
    input.model ?? null,
    input.modelInputModalities ?? null,
    input.scheduleJson ?? DAILY_SCHEDULE_JSON,
    input.timezone ?? "UTC",
    input.enabled === false ? 0 : 1,
    input.nextDueAt,
    now,
    now,
  );
}

async function insertAgentRow(input: {
  id: string;
  name: string;
  createdAt: number;
  archivedAt?: number | null;
}) {
  await db()
    .insert(schema.agents)
    .values({
      id: input.id,
      workspaceId: WORKSPACE_ID,
      name: input.name,
      // An environment IS an agent now.
      systemPrompt: "You are Nadi.",
      provider: "mock",
      model: "mock",
      description: "",
      setupScript: "",
      sandboxEnvVarsJson: "{}",
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      archivedAt: input.archivedAt ?? null,
    });
}

async function insertProjectWithDefaultAgent(input: {
  id: string;
  defaultAgentId: string | null;
  createdAt: number;
}) {
  await db().insert(schema.projects).values({
    id: input.id,
    workspaceId: WORKSPACE_ID,
    name: "Test Project",
    description: "",
    customInstructions: "",
    defaultAgentId: input.defaultAgentId,
    archivedAt: null,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
}

async function insertAutomaton(input: AutomatonInput) {
  await prepareAutomaton(input).run();
}

async function insertAutomata(inputs: AutomatonInput[]) {
  const now = Date.now();
  await env.REGISTRY_DB.batch(inputs.map((input) => prepareAutomaton(input, now)));
}

async function getThread(threadId: string) {
  return db().select().from(schema.threadIndex).where(eq(schema.threadIndex.id, threadId)).get();
}

async function insertRun(input: {
  id: string;
  automatonId: string;
  dueAt: number | null;
  trigger: AutomatonRunTrigger;
  status: AutomatonRunStatus;
  threadId?: string | null;
  createdAt?: number;
  updatedAt?: number;
}) {
  const createdAt = input.createdAt ?? Date.now();
  const updatedAt = input.updatedAt ?? createdAt;
  await env.REGISTRY_DB.prepare(
    "INSERT INTO automaton_runs (id, automaton_id, workspace_id, due_at, trigger, thread_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      input.id,
      input.automatonId,
      WORKSPACE_ID,
      input.dueAt,
      input.trigger,
      input.threadId ?? null,
      input.status,
      createdAt,
      updatedAt,
    )
    .run();
}

async function getAutomaton(id: string) {
  return db().select().from(schema.automata).where(eq(schema.automata.id, id)).get();
}

async function listRunsFor(automatonId: string) {
  return db()
    .select()
    .from(schema.automatonRuns)
    .where(eq(schema.automatonRuns.automatonId, automatonId))
    .all();
}

beforeEach(async () => {
  // The shared setup.ts beforeEach truncates every registry table first.
  await seedWorkspace();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fireDueAutomata (real D1 + real DO dispatch)", () => {
  it("wedge recovery: a post-claim failure is marked failed with the real cause and the schedule still advances", async () => {
    const dueAt = 1_800_000_000_000;
    await insertAutomaton({ id: "auto_wedge", nextDueAt: dueAt, projectId: "missing-project" });

    const result = await fireDueAutomata(env, dueAt + 1000);
    expect(result).toEqual({ fired: 0, skipped: 1 });

    const runs = await listRunsFor("auto_wedge");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failed");
    expect(runs[0]?.error).toContain("project_not_found");
    expect(runs[0]?.error).not.toContain("run never started");
    expect(runs[0]?.threadId).toEqual(expect.any(String));

    const automaton = await getAutomaton("auto_wedge");
    expect(automaton?.nextDueAt).not.toBeNull();
    expect(automaton?.nextDueAt as number).toBeGreaterThan(dueAt);

    // A second tick at the new due time must claim independently, not
    // conflict with the due the first tick already consumed.
    const nextDue = automaton!.nextDueAt as number;
    const secondResult = await fireDueAutomata(env, nextDue + 1000);
    expect(secondResult).toEqual({ fired: 0, skipped: 1 });

    const runsAfterSecond = await listRunsFor("auto_wedge");
    expect(runsAfterSecond).toHaveLength(2);
    expect(runsAfterSecond.every((run) => run.status === "failed")).toBe(true);

    const automatonAfterSecond = await getAutomaton("auto_wedge");
    expect(automatonAfterSecond?.nextDueAt as number).toBeGreaterThan(nextDue);
  });

  it("skips rather than piling onto an unfinished run (overlap)", async () => {
    // Real-time based (not the fixed constant used above): the reaper compares
    // this run's `updatedAt` against `now - AUTOMATON_RUNNING_TIMEOUT_MS`, and
    // `now` here is whatever we pass to fireDueAutomata below — mixing a fixed
    // far-away `dueAt` with a wall-clock `updatedAt` default would make the
    // reaper (wrongly, for the test's purposes) treat this fresh run as stale.
    const dueAt = Date.now() - 1000;
    await insertAutomaton({ id: "auto_overlap", nextDueAt: dueAt });
    await insertRun({
      id: "arun_overlap_prior",
      automatonId: "auto_overlap",
      dueAt: dueAt - 86_400_000,
      trigger: "scheduled",
      status: "running",
    });

    const result = await fireDueAutomata(env, dueAt + 1000);
    expect(result).toEqual({ fired: 0, skipped: 1 });

    const runs = await listRunsFor("auto_overlap");
    const skipRun = runs.find((run) => run.dueAt === dueAt);
    expect(skipRun?.status).toBe("skipped");
    expect(skipRun?.threadId).toBeNull();
    expect(skipRun?.error).toBe("previous run still unfinished");

    const automaton = await getAutomaton("auto_overlap");
    expect(automaton?.nextDueAt as number).toBeGreaterThan(dueAt);
  });

  it("skips a stale due and rolls forward without firing a backlog", async () => {
    // Pinned, not Date.now(): the schedule is daily at 08:00 UTC and the grace is
    // 1h, so a wall-clock `now` in [08:00, 09:01) UTC puts `dueAt` before today's
    // 08:00. Rolling forward then lands on an 08:00 already in the past, the
    // second tick legitimately fires it, and this test failed — for 61 minutes a
    // day. The production roll-forward is correct; the fixture was not.
    const now = Date.UTC(2026, 0, 15, 12, 0, 0);
    const dueAt = now - AUTOMATON_GRACE_MS - 60_000;
    await insertAutomaton({ id: "auto_stale", nextDueAt: dueAt });

    const result = await fireDueAutomata(env, now);
    expect(result).toEqual({ fired: 0, skipped: 1 });

    const runs = await listRunsFor("auto_stale");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("skipped");
    expect(runs[0]?.error).toBe("missed due window");
    expect(runs[0]?.dueAt).toBe(dueAt);

    const expectedNextDue = computeNextDueAt(parseSchedule(DAILY_SCHEDULE_JSON), "UTC", dueAt);
    const automaton = await getAutomaton("auto_stale");
    expect(automaton?.nextDueAt).toBe(expectedNextDue);

    // A second tick shortly after: the automaton is not due again (rolled
    // forward past today), so nothing further fires — no backlog.
    const secondResult = await fireDueAutomata(env, now + 1000);
    expect(secondResult).toEqual({ fired: 0, skipped: 0 });
    const runsAfterSecond = await listRunsFor("auto_stale");
    expect(runsAfterSecond).toHaveLength(1);
  });

  it("prefers skip_overlap over skip_stale when both apply", async () => {
    const dueAt = Date.now() - AUTOMATON_GRACE_MS - 60_000;
    await insertAutomaton({ id: "auto_both", nextDueAt: dueAt });
    await insertRun({
      id: "arun_both_prior",
      automatonId: "auto_both",
      dueAt: dueAt - 86_400_000,
      trigger: "scheduled",
      status: "queued",
    });

    const result = await fireDueAutomata(env, Date.now());
    expect(result).toEqual({ fired: 0, skipped: 1 });

    const runs = await listRunsFor("auto_both");
    const skipRun = runs.find((run) => run.dueAt === dueAt);
    expect(skipRun?.status).toBe("skipped");
    expect(skipRun?.error).toBe("previous run still unfinished");
  });

  it("reaps a run stuck in running past the timeout, unblocking the automaton in the same tick", async () => {
    const dueAt = Date.now() - 1000;
    // Valid agent, no project — this one is allowed to actually reach the DO;
    // we only assert it left the skip path, not that a turn completed (see
    // the report for why full completion isn't asserted here).
    await insertAutomaton({ id: "auto_reap", nextDueAt: dueAt });
    const staleUpdatedAt = Date.now() - AUTOMATON_RUNNING_TIMEOUT_MS - 60_000;
    await insertRun({
      id: "arun_reap_stuck",
      automatonId: "auto_reap",
      dueAt: dueAt - 86_400_000,
      trigger: "scheduled",
      status: "running",
      createdAt: staleUpdatedAt,
      updatedAt: staleUpdatedAt,
    });

    const result = await fireDueAutomata(env, Date.now());
    expect(result.fired).toBe(1);

    const runs = await listRunsFor("auto_reap");
    const reapedRun = runs.find((run) => run.id === "arun_reap_stuck");
    expect(reapedRun?.status).toBe("failed");
    expect(reapedRun?.error).toBe("no completion signal from the thread");

    const newRun = runs.find((run) => run.dueAt === dueAt);
    expect(newRun?.status).toBe("queued");
    expect(newRun?.threadId).toEqual(expect.any(String));
  });

  it("processes at most AUTOMATON_FIRE_BATCH due automata in one tick", async () => {
    const dueAt = Date.now() - 1000;
    const total = AUTOMATON_FIRE_BATCH + 5;
    await insertAutomata(
      Array.from({ length: total }, (_, i) => ({
        // Missing project keeps every one of these off the DO — fast, deterministic failures.
        id: `auto_batch_${i}`,
        nextDueAt: dueAt,
        projectId: "missing-project",
      })),
    );

    const result = await fireDueAutomata(env, Date.now());
    expect(result.fired + result.skipped).toBe(AUTOMATON_FIRE_BATCH);

    const rows = await db().select().from(schema.automata).all();
    const untouched = rows.filter((row) => row.nextDueAt === dueAt);
    const advanced = rows.filter((row) => row.nextDueAt !== dueAt);
    expect(untouched).toHaveLength(total - AUTOMATON_FIRE_BATCH);
    expect(advanced).toHaveLength(AUTOMATON_FIRE_BATCH);
  });

  it("processes the oldest due automata first with a stable id tie-break", async () => {
    const now = Date.now();
    const oldDue = now - 60_000;
    const newerDue = now - 1000;
    await insertAutomata([
      ...Array.from({ length: AUTOMATON_FIRE_BATCH }, (_, i) => ({
        id: `auto_newer_${String(i).padStart(2, "0")}`,
        nextDueAt: newerDue,
        projectId: "missing-project",
      })),
      { id: "auto_old_b", nextDueAt: oldDue, projectId: "missing-project" },
      { id: "auto_old_a", nextDueAt: oldDue, projectId: "missing-project" },
    ]);

    const result = await fireDueAutomata(env, now);
    expect(result.fired + result.skipped).toBe(AUTOMATON_FIRE_BATCH);

    const oldA = await getAutomaton("auto_old_a");
    const oldB = await getAutomaton("auto_old_b");
    expect(oldA?.nextDueAt).not.toBe(oldDue);
    expect(oldB?.nextDueAt).not.toBe(oldDue);

    const untouchedNewer = (await db().select().from(schema.automata).all()).filter(
      (row) => row.id.startsWith("auto_newer_") && row.nextDueAt === newerDue,
    );
    expect(untouchedNewer).toHaveLength(2);
  });

  it("disables an automaton with a corrupt persisted schedule instead of retrying forever", async () => {
    const dueAt = Date.now() - 1000;
    await insertAutomaton({
      id: "auto_bad_schedule",
      nextDueAt: dueAt,
      scheduleJson: '{"kind":"daily","hour":"nope","minute":0}',
    });

    const result = await fireDueAutomata(env, Date.now());
    expect(result).toEqual({ fired: 0, skipped: 1 });

    const automaton = await getAutomaton("auto_bad_schedule");
    expect(automaton?.enabled).toBe(false);
    expect(automaton?.disabledReason).toBe("Schedule is invalid.");
    expect(automaton?.nextDueAt).toBe(dueAt);
    expect(await listRunsFor("auto_bad_schedule")).toEqual([]);

    const second = await fireDueAutomata(env, Date.now() + 60_000);
    expect(second).toEqual({ fired: 0, skipped: 0 });
  });

  it("continues listing and firing due automata if stale-run reaping fails", async () => {
    const dueAt = Date.now() - 1000;
    await insertAutomaton({ id: "auto_reap_failure_continues", nextDueAt: dueAt });
    vi.spyOn(AutomatonRepository.prototype, "reapStaleRuns").mockRejectedValueOnce(
      new Error("temporary reap failure"),
    );

    const result = await fireDueAutomata(env, Date.now());

    expect(result).toEqual({ fired: 1, skipped: 0 });
    expect(await listRunsFor("auto_reap_failure_continues")).toHaveLength(1);
  });

  it("contains a due-list failure to the current tick", async () => {
    await insertAutomaton({ id: "auto_list_failure", nextDueAt: Date.now() - 1000 });
    vi.spyOn(AutomatonRepository.prototype, "listDue").mockRejectedValueOnce(
      new Error("temporary list failure"),
    );

    await expect(fireDueAutomata(env, Date.now())).resolves.toEqual({ fired: 0, skipped: 0 });
    expect(await listRunsFor("auto_list_failure")).toEqual([]);
  });

  it("keeps automata independent: one failing does not block another firing in the same batch", async () => {
    const dueAt = Date.now() - 1000;
    await insertAutomaton({ id: "auto_cross_bad", nextDueAt: dueAt, projectId: "missing-project" });
    await insertAutomaton({ id: "auto_cross_good", nextDueAt: dueAt });

    const result = await fireDueAutomata(env, Date.now());
    expect(result).toEqual({ fired: 1, skipped: 1 });

    const badRuns = await listRunsFor("auto_cross_bad");
    expect(badRuns).toHaveLength(1);
    expect(badRuns[0]?.status).toBe("failed");

    const goodRuns = await listRunsFor("auto_cross_good");
    expect(goodRuns).toHaveLength(1);
    expect(goodRuns[0]?.status).toBe("queued");

    const badAutomaton = await getAutomaton("auto_cross_bad");
    const goodAutomaton = await getAutomaton("auto_cross_good");
    expect(badAutomaton?.nextDueAt as number).toBeGreaterThan(dueAt);
    expect(goodAutomaton?.nextDueAt as number).toBeGreaterThan(dueAt);
  });

  /**
   * `beginAutomatonRun` reaches `env.THINK_THREAD_AGENT` on a thread that has
   * never been touched before (it was just created by this very fire). If
   * that dispatch is a raw `namespace.get(idFromName(...))` stub instead of
   * `getAgentByName`, it's a native Durable Object RPC call, which per
   * partyserver's own `__unsafe_ensureInitialized` doc comment bypasses the
   * fetch/alarm/webSocket entry points where a fresh instance's `onStart()`
   * normally runs. Without `onStart()`, `this.session` is never set up, and
   * the fire-and-forget submission drain crashes with "Cannot read
   * properties of undefined (reading 'appendMessage')" — deterministically,
   * every time, for every automaton (see the task report for the original
   * reproduction). `fire-due.ts` now goes through `getAgentByName`, which
   * awaits `stub.setName()` and so synchronizes `onStart()` before this test
   * ever calls `beginAutomatonRun`.
   *
   * This test proves the DO actually initialized and the turn actually
   * started, distinguishing that from "the model call itself failed" (which
   * would be an unrelated, acceptable failure in a real deployment lacking
   * credentials — irrelevant here since this test's agent uses the built-in
   * `mock` provider, which needs no API key and genuinely completes). The
   * one and only failure this test must never see again is the submission
   * landing in `status: 'error'` with the `appendMessage` message, or the
   * automaton_runs row wedged forever in `queued` — both of which are the
   * exact symptom of a raw, un-synchronized stub.
   */
  it("a real fire on a brand-new thread initializes the DO and the turn actually starts", async () => {
    const dueAt = Date.now() - 1000;
    await insertAutomaton({ id: "auto_full_fire", nextDueAt: dueAt });

    const result = await fireDueAutomata(env, Date.now());
    expect(result).toEqual({ fired: 1, skipped: 0 });

    const runs = await listRunsFor("auto_full_fire");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("queued");
    const threadId = runs[0]?.threadId;
    const runId = runs[0]?.id;
    expect(threadId).toEqual(expect.any(String));

    const thread = await db()
      .select()
      .from(schema.threadIndex)
      .where(eq(schema.threadIndex.id, threadId as string))
      .get();
    expect(thread?.runtime).toBe("think");
    expect(thread?.source).toBe("automaton");
    expect(thread?.automatonId).toBe("auto_full_fire");
    expect(thread?.automatonRunId).toBe(runId);

    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId as string));
    async function readSubmissions() {
      return runInDurableObject(stub, async (instance) => {
        return (
          instance as unknown as {
            sql: (
              strings: TemplateStringsArray,
            ) => Array<{ status: string; error_message: string | null }>;
          }
        ).sql`
          SELECT status, error_message FROM cf_think_submissions
        `;
      });
    }

    // The submission drain is fire-and-forget from `beginAutomatonRun`'s
    // point of view, so poll for it to leave the transient "pending"/
    // "running" states rather than asserting on the very next tick.
    await vi.waitFor(async () => {
      const submissions = await readSubmissions();
      expect(submissions).toHaveLength(1);
      expect(["pending", "running"]).not.toContain(submissions[0]?.status);
    });

    const submissions = await readSubmissions();
    expect(submissions).toHaveLength(1);
    // THE assertion that distinguishes "DO initialized, turn started" from
    // the old bug: a raw stub always lands here as `status: 'error'` with
    // `error_message` containing "appendMessage" — never anything else. A
    // real (even downstream-failing) model call would produce a different
    // status/message entirely.
    expect(submissions[0]?.status).not.toBe("error");
    expect(String(submissions[0]?.error_message ?? "")).not.toContain("appendMessage");
    // With the in-repo `mock` provider (no API key required) the turn
    // genuinely completes end to end — the strongest available proof that
    // this was never about the model, only about DO initialization.
    expect(submissions[0]?.status).toBe("completed");
    expect(submissions[0]?.error_message).toBeNull();

    // The automaton_runs row must move off `queued` once the turn starts
    // (`thread.started` lifecycle event fired from `beforeTurn`), and all
    // the way to `completed` once it finishes.
    await vi.waitFor(async () => {
      const run = (await listRunsFor("auto_full_fire")).find((r) => r.id === runId);
      expect(run?.status).toBe("completed");
    });
  });

  it("snapshots the agent's model onto the run thread when the automaton has no override", async () => {
    const dueAt = Date.now() - 1000;
    await insertAutomaton({ id: "auto_model_inherit", nextDueAt: dueAt });

    const result = await fireDueAutomata(env, dueAt + 1000);
    expect(result).toEqual({ fired: 1, skipped: 0 });

    const run = (await listRunsFor("auto_model_inherit"))[0];
    const thread = await getThread(run?.threadId as string);
    // The seeded agent is mock/mock.
    expect(thread?.modelProvider).toBe("mock");
    expect(thread?.model).toBe("mock");
  });

  it("snapshots the automaton's model override onto the run thread, over the agent's", async () => {
    const dueAt = Date.now() - 1000;
    await insertAutomaton({
      id: "auto_model_override",
      nextDueAt: dueAt,
      modelProvider: "mock-tool-call",
      model: "mock-override-model",
      modelInputModalities: '["text","image"]',
    });

    const result = await fireDueAutomata(env, dueAt + 1000);
    expect(result).toEqual({ fired: 1, skipped: 0 });

    const run = (await listRunsFor("auto_model_override"))[0];
    const thread = await getThread(run?.threadId as string);
    expect(thread?.modelProvider).toBe("mock-tool-call");
    expect(thread?.model).toBe("mock-override-model");
    expect(thread?.modelInputModalities).toBe('["text","image"]');
  });

  // The two "degrades to no agent" cases these replace tested a fallback
  // that no longer has anything to fall back TO: `automata.agent_id` is NOT
  // NULL and it IS the environment. The behaviour that matters now is that the
  // automaton's own agent is authoritative — an unattended run must not be
  // silently moved onto another agent's repositories and secrets.
  // Deleting an agent means its threads become read-only history, so an
  // unattended run on a DELETED agent must not proceed either — it would spend
  // tokens and clone repositories for an agent the user destroyed. What the
  // original version of this test was really guarding still holds and is
  // asserted below: the run is not silently MOVED onto another agent. It stays
  // on its own agent and fails loudly, with the reason on the run row.
  it("refuses to run once its own agent is deleted, rather than moving to another", async () => {
    const now = Date.now();
    await insertAgentRow({
      id: "wb_archived_explicit",
      name: "Archived Explicit",
      createdAt: now,
    });
    await new AgentRepository(db()).archive("wb_archived_explicit", now + 1);

    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});

    const dueAt = now - 1000;
    await insertAutomaton({
      id: "auto_stale_explicit_wb",
      nextDueAt: dueAt,
      projectId: null,
      agentId: "wb_archived_explicit",
    });

    const result = await fireDueAutomata(env, dueAt + 1000);
    expect(result).toEqual({ fired: 0, skipped: 1 });

    const runs = await listRunsFor("auto_stale_explicit_wb");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failed");
    expect(runs[0]?.error).toContain("read-only history");

    // Still ITS OWN agent — never reassigned to the workspace's or the
    // project's.
    const thread = await getThread(runs[0]?.threadId as string);
    expect(thread?.agentId).toBe("wb_archived_explicit");
    expect(warnSpy).not.toHaveBeenCalledWith("automata.agent_dropped", expect.anything());
  });

  it("does NOT adopt the project's default agent over the automaton's own", async () => {
    const now = Date.now();
    await insertAgentRow({ id: "wb_project_default", name: "Project Default", createdAt: now });
    await insertAgentRow({ id: "wb_automaton_own", name: "Automaton Own", createdAt: now });
    await insertProjectWithDefaultAgent({
      id: "proj_default_ignored",
      defaultAgentId: "wb_project_default",
      createdAt: now,
    });

    const dueAt = now - 1000;
    await insertAutomaton({
      id: "auto_own_agent_wins",
      nextDueAt: dueAt,
      projectId: "proj_default_ignored",
      agentId: "wb_automaton_own",
    });

    expect(await fireDueAutomata(env, dueAt + 1000)).toEqual({ fired: 1, skipped: 0 });
    const runs = await listRunsFor("auto_own_agent_wins");
    const thread = await getThread(runs[0]?.threadId as string);
    expect(thread?.agentId).toBe("wb_automaton_own");
  });
});
