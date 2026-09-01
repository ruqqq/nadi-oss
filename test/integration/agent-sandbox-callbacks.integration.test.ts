import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../src/db/schema";
import { applyRegistryTestSchema } from "./helpers/registry";
import { createSandboxThreadHostDeps } from "../../src/compute/sandbox-thread-host";
import type { Env } from "../../src/env";

const runInThinkDo = runInDurableObject as any;
const runInSandboxDo = runInDurableObject as any;

const now = 1_800_000_000_000;

const WATCHER = {
  title: "build",
  command: "sleep 1",
  processId: "proc_cb_watch",
  outcome: "exited" as const,
  exitCode: 0,
};

const WORKSPACE_ID = "ws_sbx_cb";
/**
 * Per-test AGENT id: the sandbox DO is keyed by agent since P3, so a single
 * shared agent id would put every `it()` in this file into ONE box. Threads that
 * are meant to share a box pass the SAME id explicitly.
 */
const agentIdFor = (key: string) => `agent_${key}`;

/**
 * Same fixture shape as `agent-sandbox-do.integration.test.ts`: seeded fresh
 * inside every `it()` because `REGISTRY_DB` gets its own storage snapshot per
 * test, and with a per-test thread id because a DO addressed by name is not
 * guaranteed a fresh snapshot per `it()`.
 */
async function seedComputeEnabledThread(
  threadId: string,
  seedWorkspace: boolean,
  agentId: string = agentIdFor(threadId),
) {
  const db = drizzle(env.REGISTRY_DB, { schema });
  if (seedWorkspace) {
    await db.insert(schema.workspaces).values({
      id: WORKSPACE_ID,
      name: "Sandbox WS",
      flagsJson: "{}",
      createdAt: now,
    });
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
    await db.insert(schema.workspaceSandboxSettings).values({
      workspaceId: WORKSPACE_ID,
      enabled: true,
      provider: "mock",
      providerConfigJson: JSON.stringify({ kind: "mock" }),
      image: "",
      createdAt: now,
      updatedAt: now,
    });
  }
  await db.insert(schema.threadIndex).values({
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

/** The AGENT's box. `key` is the agent id, not the thread id — P3 re-keyed it. */
function sandboxStub(key: string) {
  return env.AGENT_SANDBOX.get(env.AGENT_SANDBOX.idFromName(agentIdFor(key)));
}

function threadStub(threadId: string) {
  return env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));
}

/** The raw transcript of a Think thread, as JSON text for substring matching. */
async function transcriptText(threadId: string): Promise<string> {
  const messages = await runInThinkDo(threadStub(threadId), async (instance: any) => {
    await instance.__unsafe_ensureInitialized();
    return await instance.exportRawHistory();
  });
  return JSON.stringify(messages);
}

/**
 * Drive the DO's own back-call deps — the exact object `resolveService` hands
 * to the compute service — from inside the sandbox DO, which is where a real
 * reminder is raised.
 */
async function backCalls(threadId: string, agentKey: string = threadId) {
  return {
    deliver: (body: string, mode: "deferred" | "proactive") =>
      runInSandboxDo(sandboxStub(agentKey), async (instance: any) => {
        await instance.threadHostDeps(threadId).deliverSystemReminder(body, mode);
      }),
    /** Run anything against the DO's own dep object, from inside the DO. */
    with: <T>(fn: (deps: any) => Promise<T>): Promise<T> =>
      runInSandboxDo(sandboxStub(agentKey), async (instance: any) =>
        fn(instance.threadHostDeps(threadId)),
      ),
  };
}

/** A ledger row shaped like the one the compute layer registers for a process. */
function processRow(id: string) {
  return {
    id,
    kind: "process" as const,
    startedAt: now,
    lastAliveAt: now,
    staleAfterMs: 180_000,
    deadlineAt: now + 600_000,
    generation: "gen_test",
    terminal: null,
    deliveredAt: null,
  };
}

describe("AgentSandbox back-calls into the owning thread DO", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  it("delivers a deferred reminder into the OWNING thread and no other", async () => {
    const owner = "thr_cb_owner";
    const sibling = "thr_cb_sibling";
    // ONE agent, TWO threads — which is exactly the P3 shape: both threads share
    // a single box, so the back-call's routing is the only thing keeping the
    // reminder out of the sibling's transcript.
    const agentId = agentIdFor("cb_routing");
    await seedComputeEnabledThread(owner, true, agentId);
    await seedComputeEnabledThread(sibling, false, agentId);

    const body = "sandbox-callback-marker-alpha";
    await (await backCalls(owner, "cb_routing")).deliver(body, "deferred");

    expect(await transcriptText(owner)).toContain(body);
    // The half that makes this test meaningful: routing, not just delivery.
    expect(await transcriptText(sibling)).not.toContain(body);
  });

  it("runs the THREAD DO's ledger sweep from the sandbox's back-call", async () => {
    // The sweep is the one capability whose TRIGGER moved without its code: the
    // sandbox's alarm chains it behind the tick, but it still reads the thread's
    // ledger and still delivers into the thread's transcript.
    const threadId = "thr_cb_sweep";
    await seedComputeEnabledThread(threadId, true);
    const calls = await backCalls(threadId);
    const id = "proc_cb_sweep";

    // Registered already silent past `staleAfterMs`, measured against the REAL
    // clock the sweep classifies with — this file fakes no timers, and the `now`
    // fixture is a FUTURE epoch, so a row built from it reads as freshly alive.
    // Stamped-in staleness is not an option: `stampAlive` never moves backwards.
    const stale = Date.now() - 10_000_000;
    await calls.with((deps: any) =>
      deps.workLedger.register({
        ...processRow(id),
        startedAt: stale,
        lastAliveAt: stale,
        deadlineAt: Date.now() + 600_000,
      }),
    );
    await calls.with((deps: any) => deps.sweepWorkLedger({ kind: "disabled" }));

    const rows = await runInThinkDo(threadStub(threadId), async (instance: any) => {
      await instance.__unsafe_ensureInitialized();
      return (await instance.debugWorkLedger()).rows;
    });
    const row = rows.find((entry: any) => entry.id === id);
    expect(row.terminal).not.toBeNull();
    expect(row.terminal.reason).toBe("no_liveness");
  });

  it("writes the sandbox's process rows into the THREAD DO's work ledger", async () => {
    // The ledger cannot move with the machine — subagent rows live in it and
    // the reaper reads it here — so the sandbox reports liveness across RPC.
    // This drives the real sink against the real store and reads the row back
    // through the thread DO's own accessor.
    const threadId = "thr_cb_ledger";
    await seedComputeEnabledThread(threadId, true);
    const calls = await backCalls(threadId);
    const id = "proc_cb_1";

    const observed = await calls.with(async (deps: any) => {
      await deps.workLedger.register(processRow(id));
      await deps.workLedger.stampAlive(id, now + 5_000);
      const closed = await deps.workLedger.terminalize(id, {
        outcome: "exited",
        reason: "process_exit",
        at: now + 6_000,
        detail: "process exited",
        exitCode: 0,
      });
      const beforeStamp = await deps.workLedger.isDelivered(id);
      const stamped = await deps.workLedger.markDelivered(id, now + 6_000);
      const afterStamp = await deps.workLedger.isDelivered(id);
      const horizon = await deps.getWorkHorizon();
      return { closed, beforeStamp, stamped, afterStamp, horizon };
    });

    expect(observed.closed).toBe(true);
    expect(observed.beforeStamp).toBe(false);
    expect(observed.stamped).toBe(true);
    expect(observed.afterStamp).toBe(true);
    // The horizon is the thread's own `workHorizon`, not a number the sandbox
    // invented: a terminal row that has been delivered owes no retry.
    expect(observed.horizon).toBeNull();

    const rows = await runInThinkDo(threadStub(threadId), async (instance: any) => {
      await instance.__unsafe_ensureInitialized();
      return (await instance.debugWorkLedger()).rows;
    });
    expect(rows.map((row: any) => row.id)).toContain(id);
    expect(rows.find((row: any) => row.id === id).deliveredAt).not.toBeNull();
  });

  it("reads the blocking-work gate and the clean bit off the THREAD DO", async () => {
    const threadId = "thr_cb_state";
    await seedComputeEnabledThread(threadId, true);
    const calls = await backCalls(threadId);

    // No subagent rows on a fresh thread, so nothing holds the machine.
    expect(await calls.with((deps: any) => deps.hasBlockingWork())).toBe(false);

    expect(await calls.with((deps: any) => deps.isSandboxDeclaredClean())).toBe(false);
    await calls.with((deps: any) => deps.setSandboxDeclaredClean(true));
    expect(await calls.with((deps: any) => deps.isSandboxDeclaredClean())).toBe(true);
    // The bit is on the THREAD's storage, which is the point of the back-call.
    expect(
      await runInThinkDo(threadStub(threadId), async (instance: any) => {
        await instance.__unsafe_ensureInitialized();
        return await instance.getSandboxDeclaredClean();
      }),
    ).toBe(true);

    await calls.with((deps: any) => deps.markSandboxDirty());
    expect(await calls.with((deps: any) => deps.isSandboxDeclaredClean())).toBe(false);
  });

  it("swallows a back-call failure instead of faulting the compute path", async () => {
    // An unreachable thread namespace is the failure the compute path must
    // survive: the command already ran on the machine, so a notification that
    // cannot be delivered may not turn it into an error.
    const deps = createSandboxThreadHostDeps(
      { THINK_THREAD_AGENT: undefined } as unknown as Env,
      "thr_cb_unreachable",
    );
    await expect(deps.deliverSystemReminder("orphan-marker", "deferred")).resolves.toBeUndefined();
    await expect(deps.sweepWorkLedger({ kind: "unresolved" })).resolves.toBeUndefined();
    // A watcher-completion reminder is still a COMMAND result unless the caller
    // says otherwise; only `mustDeliver` changes the semantics.
    await expect(
      deps.deliverSystemReminder("orphan-marker", "proactive", { watcher: WATCHER }),
    ).resolves.toBeUndefined();
  });

  /**
   * The one back-call that MUST NOT swallow. `pollWatcher` stamps
   * `markDelivered` unconditionally, after this await, so that a throw leaves
   * the ledger row owed and the sweep retries it. Swallowing here discharges an
   * obligation the model never saw — thread-service.ts:3020-3045.
   *
   * The far side still ENCODES its failures; this throw is raised on the near
   * side, inside the sandbox's own isolate, where the compute service can see
   * it.
   */
  it("re-throws a failed reminder on the watcher-poll path", async () => {
    const deps = createSandboxThreadHostDeps(
      { THINK_THREAD_AGENT: undefined } as unknown as Env,
      "thr_cb_unreachable_watch",
    );
    await expect(
      deps.deliverSystemReminder("orphan-marker", "proactive", {
        watcher: WATCHER,
        mustDeliver: true,
      }),
    ).rejects.toThrow(/sandbox_reminder_undelivered/);
  });

  it("keeps a read back-call's fallback on the side that preserves work", async () => {
    // An unreachable thread DO cannot answer, but these reads must still return
    // something. Each fallback is the answer that cannot destroy work: assume a
    // child holds the machine, assume the workspace is NOT verified clean, and
    // assume nobody has told the model yet (a duplicate beats silence).
    const deps = createSandboxThreadHostDeps(
      { THINK_THREAD_AGENT: undefined } as unknown as Env,
      "thr_cb_unreachable_reads",
    );
    expect(await deps.hasBlockingWork()).toBe(true);
    expect(await deps.isSandboxDeclaredClean()).toBe(false);
    expect(await deps.workLedger.isDelivered("p1")).toBe(false);
    expect(
      await deps.workLedger.terminalize("p1", {
        outcome: "exited",
        reason: "process_exit",
        at: now,
        detail: "",
      }),
    ).toBe(false);
    expect(await deps.workLedger.markDelivered("p1", now)).toBe(false);
    expect(await deps.getWorkHorizon()).toBeNull();
  });
});
