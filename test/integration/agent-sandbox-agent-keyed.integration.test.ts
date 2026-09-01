/**
 * P3 TASK 1 — the sandbox Durable Object is keyed by AGENT, not by thread.
 *
 * Two things travel with that one-line change, and neither is visible to
 * typecheck:
 *
 *   1. THE TRAP. `alarm()` used to recover its thread identity as
 *      `params?.threadId ?? this.ctx.id.name`. That name is now an AGENT id, so
 *      the fallback would sweep — and deliver into — a thread DO named after the
 *      agent, silently, forever. There is no fallback any more.
 *   2. THE FAN-OUT. One agent-keyed alarm is the ONLY wake the work ledger has
 *      (P1 moved the compute alarm off the thread DO, and `runSandboxComputeAlarm`
 *      explains why a second alarm cannot be added back). So the sweep runs for
 *      EVERY thread the box has served, not just the last one to open a session.
 *
 * Both are asserted here against real Durable Objects, real back-calls and the
 * real ledger — the sweep genuinely terminalizes a stale row, so a sweep that
 * never reached a thread shows up as a row that is still open.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../src/db/schema";
import { applyRegistryTestSchema } from "./helpers/registry";

const runInThinkDo = runInDurableObject as any;
const runInSandboxDo = runInDurableObject as any;

const now = 1_800_000_000_000;
const WORKSPACE_ID = "ws_sbx_keyed";

/** Mirrors the DO's own `SWEEP_ROSTER_PREFIX` — the roster is what the fan-out reads. */
const SWEEP_ROSTER_PREFIX = "sb:sw:";

/**
 * Seeded fresh inside every `it()` — `REGISTRY_DB` gets its own storage snapshot
 * per test, so a `beforeAll` write does not reach one. Every test also uses its
 * OWN agent id, because that is now what picks the sandbox DO and a Durable
 * Object addressed by name is not proven to get a fresh snapshot per test.
 */
async function seedAgent(agentId: string) {
  const db = drizzle(env.REGISTRY_DB, { schema });
  await db
    .insert(schema.workspaces)
    .values({ id: WORKSPACE_ID, name: "Keyed WS", flagsJson: "{}", createdAt: now })
    .onConflictDoNothing();
  await db.insert(schema.agents).values({
    id: agentId,
    workspaceId: WORKSPACE_ID,
    name: "Nadi",
    systemPrompt: "",
    provider: "anthropic",
    model: "claude-opus-5",
    modelInputModalities: '["text"]',
    reasoningEffort: "medium",
    createdAt: now,
  });
  await db
    .insert(schema.workspaceSandboxSettings)
    .values({
      workspaceId: WORKSPACE_ID,
      enabled: true,
      provider: "mock",
      providerConfigJson: JSON.stringify({ kind: "mock" }),
      image: "",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
}

async function seedThread(threadId: string, agentId: string) {
  await drizzle(env.REGISTRY_DB, { schema }).insert(schema.threadIndex).values({
    id: threadId,
    workspaceId: WORKSPACE_ID,
    agentId,
    kind: "regular",
    title: "T",
    source: "manual",
    createdAt: now,
    updatedAt: now,
  });
}

/** The box. `idFromName(agentId)` is the whole point of this file. */
function sandboxStub(agentId: string) {
  return env.AGENT_SANDBOX.get(env.AGENT_SANDBOX.idFromName(agentId));
}

function threadStub(threadId: string) {
  return env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));
}

/**
 * A ledger row that is ALREADY past its staleness window against the real
 * clock, so a sweep that reaches it must terminalize it `no_liveness`.
 * `stampAlive` never moves backwards, so the staleness has to be built in.
 */
function staleRow(id: string) {
  const stale = Date.now() - 10_000_000;
  return {
    id,
    kind: "process" as const,
    startedAt: stale,
    lastAliveAt: stale,
    staleAfterMs: 180_000,
    deadlineAt: Date.now() + 600_000,
    generation: "gen_keyed",
    terminal: null,
    deliveredAt: null,
  };
}

/**
 * Register a stale row through the BOX's own back-call deps, which is also what
 * puts the thread on the sweep roster — the production path, not a fixture.
 */
async function registerStaleRow(agentId: string, threadId: string, rowId: string) {
  await runInSandboxDo(sandboxStub(agentId), async (instance: any) => {
    await instance.threadHostDeps(threadId).workLedger.register(staleRow(rowId));
  });
}

async function ledgerRow(threadId: string, rowId: string) {
  const rows = await runInThinkDo(threadStub(threadId), async (instance: any) => {
    await instance.__unsafe_ensureInitialized();
    return (await instance.debugWorkLedger()).rows;
  });
  return rows.find((row: any) => row.id === rowId);
}

async function openSession(agentId: string, threadId: string) {
  const opened = await sandboxStub(agentId).session({
    threadId,
    supportsProcessMonitor: true,
    runtimeConfig: { workspaceId: WORKSPACE_ID, agentId },
  });
  if (!opened.ok) throw new Error(`session failed: ${opened.error.code}`);
  return opened;
}

async function fireAlarm(agentId: string) {
  await runInSandboxDo(sandboxStub(agentId), async (instance: any) => {
    await instance.alarm();
  });
}

async function rosterThreads(agentId: string): Promise<string[]> {
  return await runInSandboxDo(sandboxStub(agentId), async (instance: any) => {
    const rows = await instance.ctx.storage.list({ prefix: SWEEP_ROSTER_PREFIX });
    return [...rows.keys()].map((key: string) => key.slice(SWEEP_ROSTER_PREFIX.length));
  });
}

describe("the sandbox DO is keyed by agent", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  /**
   * THE TRAP, asserted from both sides.
   *
   * The box has no recorded session (so the old code would have fallen back to
   * `ctx.id.name`), one real thread with a stale row, and a decoy thread whose
   * id IS the agent id — the scope the fallback would have swept. Only one of
   * the two rows may move.
   */
  it("sweeps the thread on its roster, never the thread named after the agent", async () => {
    const agentId = "agent_sbx_trap";
    const threadId = "thr_sbx_trap";
    await seedAgent(agentId);
    await seedThread(threadId, agentId);
    // The decoy: a real thread DO whose name is the AGENT id. Nothing in
    // production creates this, which is exactly why sweeping it would be silent.
    await seedThread(agentId, agentId);

    await registerStaleRow(agentId, threadId, "proc_real");
    await registerStaleRow(agentId, agentId, "proc_decoy");
    // The decoy must NOT be on the roster for this assertion to mean anything —
    // remove the row `registerStaleRow` just wrote for it, leaving only its
    // LEDGER row behind. The fallback would have found it by name regardless.
    await runInSandboxDo(sandboxStub(agentId), async (instance: any) => {
      await instance.ctx.storage.delete(SWEEP_ROSTER_PREFIX + agentId);
    });
    expect(await rosterThreads(agentId)).toEqual([threadId]);

    await fireAlarm(agentId);

    expect(
      (await ledgerRow(threadId, "proc_real"))?.terminal?.reason,
      "the roster's thread must be swept even with no recorded session",
    ).toBe("no_liveness");
    expect(
      (await ledgerRow(agentId, "proc_decoy"))?.terminal,
      "a thread DO named after the AGENT is not a thread — the `ctx.id.name` fallback " +
        "would have swept it, and its reminders would have gone there too",
    ).toBeNull();
  });

  /**
   * THE FAN-OUT. Two threads of one agent, both with open work, and only ONE of
   * them opened the session the alarm replays. A sweep driven off
   * `params.threadId` closes that one row and strands the other forever.
   */
  it("sweeps EVERY thread of the agent, not just the last one to open a session", async () => {
    const agentId = "agent_sbx_fan";
    const first = "thr_sbx_fan_first";
    const last = "thr_sbx_fan_last";
    await seedAgent(agentId);
    await seedThread(first, agentId);
    await seedThread(last, agentId);

    await registerStaleRow(agentId, first, "proc_first");
    await registerStaleRow(agentId, last, "proc_last");
    // `last` opens the session, so it is the only thread the tick's replayed
    // params name. `first` exists only on the roster.
    await openSession(agentId, last);
    expect((await rosterThreads(agentId)).sort()).toEqual([first, last].sort());

    await fireAlarm(agentId);

    expect(
      (await ledgerRow(first, "proc_first"))?.terminal?.reason,
      "the thread that did NOT open the last session still has to be swept",
    ).toBe("no_liveness");
    expect((await ledgerRow(last, "proc_last"))?.terminal?.reason).toBe("no_liveness");
  });

  /**
   * The roster is pruned on EVIDENCE and re-armed on the next session — and the
   * write-elision cache must be invalidated with it.
   *
   * Without the `rosterWritten.delete` in `forgetSweepThread`, a hot instance
   * elides the re-write and the thread is silently absent from every later
   * sweep: a stale cached value that changes behaviour and fails nothing, which
   * is this codebase's most expensive recurring defect.
   */
  it("prunes a swept-clean thread and puts it back on the next session", async () => {
    const agentId = "agent_sbx_prune";
    const threadId = "thr_sbx_prune";
    await seedAgent(agentId);
    await seedThread(threadId, agentId);

    await openSession(agentId, threadId);
    expect(await rosterThreads(agentId)).toEqual([threadId]);

    // Nothing open and nothing owed, and the thread DO answers — so the entry
    // has no reason to keep waking it.
    await fireAlarm(agentId);
    expect(await rosterThreads(agentId)).toEqual([]);

    // Same instance, so the elision cache is still warm. It must not swallow
    // this write.
    await openSession(agentId, threadId);
    expect(
      await rosterThreads(agentId),
      "a pruned thread must be re-added by its next session — the write-elision " +
        "cache is invalidated by the prune for exactly this reason",
    ).toEqual([threadId]);
  });

  /**
   * An unreachable thread is NOT a clean one. `getWorkHorizon` collapses both to
   * `null`, which is why the prune reads `probeWorkHorizon` instead.
   */
  it("keeps a thread on the roster when its DO could not be reached", async () => {
    const agentId = "agent_sbx_unreach";
    const threadId = "thr_sbx_unreach";
    await seedAgent(agentId);
    await seedThread(threadId, agentId);

    const probe = await runInSandboxDo(sandboxStub(agentId), async (instance: any) => {
      const reachable = await instance.threadHostDeps(threadId).probeWorkHorizon();
      const unreachable = await (
        await import("../../src/compute/sandbox-thread-host")
      )
        .createSandboxThreadHostDeps({ THINK_THREAD_AGENT: undefined } as any, threadId)
        .probeWorkHorizon();
      return { reachable, unreachable };
    });

    expect(probe.reachable).toEqual({ reachable: true, horizon: null });
    expect(probe.unreachable).toEqual({ reachable: false, horizon: null });
  });
});
