import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../src/db/schema";
import { applyRegistryTestSchema } from "./helpers/registry";
import { COMPUTE_EVICTION_SCHEDULE_KEY } from "../../src/agent/compute-tools";
import { createSandboxThreadHostDeps } from "../../src/compute/sandbox-thread-host";
import type { Env } from "../../src/env";

const runInThinkDo = runInDurableObject as any;
const runInSandboxDo = runInDurableObject as any;

const now = 1_800_000_000_000;

const WORKSPACE_ID = "ws_sbx_cb";
const AGENT_ID = "agent_sbx_cb";

/**
 * Same fixture shape as `agent-sandbox-do.integration.test.ts`: seeded fresh
 * inside every `it()` because `REGISTRY_DB` gets its own storage snapshot per
 * test, and with a per-test thread id because a DO addressed by name is not
 * guaranteed a fresh snapshot per `it()`.
 */
async function seedComputeEnabledThread(threadId: string, seedWorkspace: boolean) {
  const db = drizzle(env.REGISTRY_DB, { schema });
  if (seedWorkspace) {
    await db.insert(schema.workspaces).values({
      id: WORKSPACE_ID,
      name: "Sandbox WS",
      flagsJson: "{}",
      createdAt: now,
    });
    await db.insert(schema.agents).values({
      id: AGENT_ID,
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
    agentId: AGENT_ID,
    kind: "regular",
    title: "T",
    source: "manual",
    createdAt: now,
    updatedAt: now,
  });
}

function sandboxStub(threadId: string) {
  return env.AGENT_SANDBOX.get(env.AGENT_SANDBOX.idFromName(threadId));
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
async function backCalls(threadId: string) {
  return {
    deliver: (body: string, mode: "deferred" | "proactive") =>
      runInSandboxDo(sandboxStub(threadId), async (instance: any) => {
        await instance.threadHostDeps(threadId).deliverSystemReminder(body, mode);
      }),
    schedule: (timestampMs: number) =>
      runInSandboxDo(sandboxStub(threadId), async (instance: any) => {
        await instance.threadHostDeps(threadId).scheduleEviction(timestampMs);
      }),
    cancel: () =>
      runInSandboxDo(sandboxStub(threadId), async (instance: any) => {
        await instance.threadHostDeps(threadId).cancelEviction();
      }),
  };
}

describe("AgentSandbox back-calls into the owning thread DO", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  it("delivers a deferred reminder into the OWNING thread and no other", async () => {
    const owner = "thr_cb_owner";
    const sibling = "thr_cb_sibling";
    await seedComputeEnabledThread(owner, true);
    await seedComputeEnabledThread(sibling, false);

    const body = "sandbox-callback-marker-alpha";
    await (await backCalls(owner)).deliver(body, "deferred");

    expect(await transcriptText(owner)).toContain(body);
    // The half that makes this test meaningful: routing, not just delivery.
    expect(await transcriptText(sibling)).not.toContain(body);
  });

  it("arms and cancels eviction on the THREAD DO's storage", async () => {
    const threadId = "thr_cb_evict";
    await seedComputeEnabledThread(threadId, true);

    const calls = await backCalls(threadId);
    await calls.schedule(now + 60_000);

    const armed = await runInThinkDo(threadStub(threadId), async (instance: any) => {
      await instance.__unsafe_ensureInitialized();
      return await instance.ctx.storage.get(COMPUTE_EVICTION_SCHEDULE_KEY);
    });
    expect(typeof armed).toBe("string");

    await calls.cancel();
    const cleared = await runInThinkDo(threadStub(threadId), async (instance: any) => {
      return await instance.ctx.storage.get(COMPUTE_EVICTION_SCHEDULE_KEY);
    });
    expect(cleared).toBeUndefined();
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
    await expect(deps.scheduleEviction(now + 1_000)).resolves.toBeUndefined();
    await expect(deps.cancelEviction()).resolves.toBeUndefined();
  });
});
