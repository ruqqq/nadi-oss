/**
 * The celld ticker Durable Object (CRON_TICKER) is the celld-only replacement
 * for Cloudflare's `scheduled()` handler: celld rejects the `triggers` config
 * key and never invokes `scheduled()`, so without it automata never fire,
 * idle threads are never archived, and stale search projections are never
 * repaired — silently. The ticker re-arms itself every minute and calls the
 * exact same job functions `scheduled()` calls (`fireDueAutomata`,
 * `autoArchiveIdleThreads`, `repairStaleThreadSearchProjections`) unchanged.
 * The fireDueAutomata orchestration itself is covered end-to-end in
 * automaton-scheduled.integration.test.ts; these tests drive the ticker DO's
 * real alarm in-pool and assert on observable effects (run rows, archived
 * threads, registry markers), not on log lines.
 */
import {
  createExecutionContext,
  env,
  runDurableObjectAlarm,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as schema from "../../src/db/schema";
import type { Env } from "../../src/env";
import { armCelldTicker } from "../../src/celld/ticker";
import {
  DAILY_INTERVAL_MS,
  TICKER_LAST_DAILY_RUN_KEY,
  TICKER_LAST_TICK_KEY,
  TICKER_INSTANCE_NAME,
} from "../../src/celld/ticker-policy";
import { RegistryKV } from "../../src/db/registry-kv";
import { seedRegistryThread } from "./helpers/registry";
import { AUTO_ARCHIVE_IDLE_DAYS } from "../../src/agent/auto-archive";

const WORKSPACE_ID = "ws_ticker";
const USER_ID = "usr_ticker";
const AGENT_ID = "agt_ticker";
const DAY_MS = 86_400_000;

// TEST-ONLY: CRON_TICKER is bound in the pool (see vitest.config.ts); the
// pool's own `env` type is generated from the Cloudflare configs and does not
// carry the celld-only bindings, so cast like the registry facade tests do.
const poolEnv = env as unknown as Env;

function db() {
  return drizzle(env.REGISTRY_DB, { schema });
}

function tickerStub() {
  return poolEnv.CRON_TICKER!.get(poolEnv.CRON_TICKER!.idFromName(TICKER_INSTANCE_NAME));
}

function registryKv() {
  return new RegistryKV(poolEnv.REGISTRY_DO!);
}

/** The ticker's own storage: the alarm it armed, or null. */
function readAlarm() {
  return runInDurableObject(tickerStub(), async (_instance, state) => state.storage.getAlarm());
}

async function seedWorkspace() {
  const now = Date.now();
  await env.REGISTRY_DB.prepare(
    "INSERT OR IGNORE INTO workspaces (id, name, created_at) VALUES (?, ?, ?)",
  )
    .bind(WORKSPACE_ID, "Ticker", now)
    .run();
  await env.REGISTRY_DB.prepare(
    "INSERT OR IGNORE INTO users (id, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(USER_ID, "ticker@example.com", 1, now, now)
    .run();
  await env.REGISTRY_DB.prepare(
    "INSERT OR IGNORE INTO agents (id, workspace_id, name, system_prompt, provider, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(AGENT_ID, WORKSPACE_ID, "Agent", "", "mock", "mock", now)
    .run();
}

async function insertAutomaton(input: {
  id: string;
  nextDueAt: number | null;
  projectId?: string | null;
}) {
  const now = Date.now();
  await env.REGISTRY_DB.prepare(
    `INSERT INTO automata (id, workspace_id, owner_user_id, agent_id, project_id, name, prompt, schedule_json, timezone, enabled, next_due_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  )
    .bind(
      input.id,
      WORKSPACE_ID,
      USER_ID,
      AGENT_ID,
      input.projectId ?? null,
      "Ticker automaton",
      "You are on schedule.",
      '{"kind":"daily","hour":8,"minute":0}',
      "UTC",
      input.nextDueAt,
      now,
      now,
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

/** Archiving refuses to snapshot-and-destroy an empty transcript, so give the
 * idle thread real history before the daily sweep sees it. */
async function seedThreadMessages(threadId: string, messages: unknown[]) {
  const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));
  await (runInDurableObject as any)(stub, async (instance: any) => {
    await instance.__unsafe_ensureInitialized();
    await instance.addMessages(messages);
  });
}

describe("celld ticker (CRON_TICKER)", () => {
  it("fires a due automaton through the ticker alarm, using the real fireDueAutomata", async () => {
    await seedWorkspace();
    // Within the 1h grace window of the tick's wall clock: a stale due would
    // be skipped rather than fired, which would make this test green against a
    // ticker that only half-ran the automata path.
    const dueAt = Date.now() - 1_000;
    await insertAutomaton({ id: "auto_tick_fire", nextDueAt: dueAt });

    const stub = tickerStub();
    await stub.arm();
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const runs = await listRunsFor("auto_tick_fire");
    expect(runs).toHaveLength(1);
    // The claim lands before the fire-and-forget turn drain, so the run may
    // already be off "queued" by the time we look; any non-terminal, non-skip
    // state is a fire. failed/skipped are the states that prove it did NOT.
    expect(["failed", "skipped"]).not.toContain(runs[0]?.status);
    const threadId = runs[0]?.threadId;
    expect(threadId).toEqual(expect.any(String));

    const thread = await db()
      .select()
      .from(schema.threadIndex)
      .where(eq(schema.threadIndex.id, threadId as string))
      .get();
    expect(thread?.source).toBe("automaton");
    expect(thread?.automatonId).toBe("auto_tick_fire");

    const automaton = await getAutomaton("auto_tick_fire");
    expect(automaton?.nextDueAt as number).toBeGreaterThan(dueAt);
  });

  it("re-arms itself, so ticking continues, and arm() is idempotent", async () => {
    const stub = tickerStub();
    // The integration-fast pool runs with isolate:false, so DO storage is
    // shared across tests in the file — start from a known state.
    await runInDurableObject(stub, async (_instance, state) => state.storage.deleteAlarm());
    expect(await runDurableObjectAlarm(stub)).toBe(false);

    await stub.arm();
    const firstAlarmAt = await readAlarm();
    expect(firstAlarmAt).not.toBeNull();

    // arm() must not move an existing alarm forward (a busy deployment would
    // otherwise never let the alarm fire).
    await stub.arm();
    expect(await readAlarm()).toBe(firstAlarmAt);

    // A real alarm fires, and alarm() schedules the next one — ticking
    // continues with no further fetch-side help.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const nextAlarmAt = await readAlarm();
    expect(nextAlarmAt).not.toBeNull();
    expect(nextAlarmAt as number).toBeGreaterThan(Date.now());
    expect(await runDurableObjectAlarm(stub)).toBe(true);
  });

  it("arms the first alarm from the worker fetch path, and is a no-op on Cloudflare", async () => {
    // Start from a known state (DO storage is shared across tests here).
    await runInDurableObject(tickerStub(), async (_instance, state) => state.storage.deleteAlarm());

    // Cloudflare: no CRON_TICKER binding → nothing is armed and nothing throws.
    armCelldTicker(
      { ...poolEnv, CRON_TICKER: undefined } as unknown as Env,
      createExecutionContext(),
    );
    expect(await readAlarm()).toBeNull();

    // celld: the first fetch arms the ticker's first alarm.
    const ctx = createExecutionContext();
    armCelldTicker(poolEnv, ctx);
    await waitOnExecutionContext(ctx);
    const armedAt = await readAlarm();
    expect(armedAt).not.toBeNull();
    expect(armedAt as number).toBeGreaterThan(Date.now());
  });

  it("runs the daily sweep when due but not every tick, deciding from registry state", async () => {
    // DO storage is shared across tests in this pool, so a previous test's
    // tick may have left a fresh daily marker (which would make tick 1 see
    // "not due") — clear both markers first.
    await registryKv().delete(TICKER_LAST_DAILY_RUN_KEY);
    await registryKv().delete(TICKER_LAST_TICK_KEY);

    // A thread idle long enough that the real autoArchiveIdleThreads will
    // pick it up — the observable proof that the sweep actually ran.
    const stale = await seedRegistryThread(env.REGISTRY_DB, {
      threadId: "thr_idle",
      runtime: "think",
      updatedAt: Date.now() - (AUTO_ARCHIVE_IDLE_DAYS + 1) * DAY_MS,
    });
    await seedThreadMessages(stale.threadId, [
      { id: "s1", role: "user", parts: [{ type: "text", text: "stale" }] },
    ]);

    const stub = tickerStub();
    await stub.arm();

    // Fresh deployment: no marker → tick 1 is due. The idle thread must be
    // archived by the real autoArchiveIdleThreads, and the marker recorded.
    await runDurableObjectAlarm(stub);
    const markerAfterFirst = await registryKv().get(TICKER_LAST_DAILY_RUN_KEY);
    expect(markerAfterFirst).not.toBeNull();
    const archived = await db()
      .select({ archivedAt: schema.threadIndex.archivedAt })
      .from(schema.threadIndex)
      .where(eq(schema.threadIndex.id, stale.threadId))
      .get();
    expect(archived?.archivedAt).not.toBeNull();

    // Tick 2, moments later: the marker is fresh → the daily sweep must NOT
    // run. The marker being unchanged is the proof (it is only written after
    // both jobs complete).
    await runDurableObjectAlarm(stub);
    expect(await registryKv().get(TICKER_LAST_DAILY_RUN_KEY)).toBe(markerAfterFirst);

    // A marker older than the daily interval → due again: the sweep runs and
    // refreshes the marker.
    const old = Date.now() - DAILY_INTERVAL_MS - 60_000;
    await registryKv().put(TICKER_LAST_DAILY_RUN_KEY, String(old));
    await runDurableObjectAlarm(stub);
    const markerAfterThird = await registryKv().get(TICKER_LAST_DAILY_RUN_KEY);
    expect(markerAfterThird).not.toBeNull();
    expect(Number(markerAfterThird)).toBeGreaterThan(old);
  });

  it("fires a due automaton exactly once across two back-to-back ticks", async () => {
    await seedWorkspace();
    const dueAt = Date.now() - 1_000;
    // Missing project: a deterministic post-claim failure (project_not_found)
    // that still claims the run and advances the schedule — no agent turn in
    // the background, so the two ticks stay fast and independent.
    await insertAutomaton({
      id: "auto_tick_twice",
      nextDueAt: dueAt,
      projectId: "missing-project",
    });

    const stub = tickerStub();
    await stub.arm();

    await runDurableObjectAlarm(stub);
    const runsAfterFirst = await listRunsFor("auto_tick_twice");
    expect(runsAfterFirst).toHaveLength(1);
    expect(runsAfterFirst[0]?.status).toBe("failed");
    expect(runsAfterFirst[0]?.error).toContain("project_not_found");
    expect(runsAfterFirst[0]?.threadId).toEqual(expect.any(String));
    const nextDueAfterFirst = (await getAutomaton("auto_tick_twice"))?.nextDueAt;

    // The second tick must not re-claim the same due: the unique-index lease
    // (idx_automaton_runs_due) is the only thing standing between the two
    // overlapping ticks and a double fire.
    await runDurableObjectAlarm(stub);
    const runsAfterSecond = await listRunsFor("auto_tick_twice");
    expect(runsAfterSecond).toHaveLength(1);
    expect((await getAutomaton("auto_tick_twice"))?.nextDueAt).toBe(nextDueAfterFirst);
  });

  it("writes the tick liveness marker and exposes it via /api/debug/celld-ticker", async () => {
    const { routeDebug } = await import("../../src/http/debug-routes");

    // Start from a known state: DO storage is shared across tests here.
    await registryKv().delete(TICKER_LAST_TICK_KEY);
    await runInDurableObject(tickerStub(), async (_instance, state) => state.storage.deleteAlarm());

    const stub = tickerStub();
    await stub.arm();
    await runDurableObjectAlarm(stub);

    const lastTick = await registryKv().get(TICKER_LAST_TICK_KEY);
    expect(lastTick).not.toBeNull();

    const res = await routeDebug(
      new Request("https://nadi.test/api/debug/celld-ticker", {
        headers: { "x-debug-token": "test-token" },
      }),
      { ...poolEnv, DEBUG_TOKEN: "test-token" } as unknown as Env,
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as {
      ticker: string;
      lastTickMs: number | null;
      lastDailyRunMs: number | null;
    };
    expect(body.ticker).toBe("celld");
    expect(body.lastTickMs).toBe(Number(lastTick));

    // On Cloudflare (no REGISTRY_DO) the route reports not_applicable rather
    // than a misleading null.
    const cloud = await routeDebug(
      new Request("https://nadi.test/api/debug/celld-ticker", {
        headers: { "x-debug-token": "test-token" },
      }),
      { ...poolEnv, REGISTRY_DO: undefined, DEBUG_TOKEN: "test-token" } as unknown as Env,
    );
    expect(cloud).not.toBeNull();
    expect((await cloud!.json()) as { ticker: string }).toMatchObject({ ticker: "not_applicable" });
  });
});
