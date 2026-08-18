import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { ThinkThreadAgent } from "../../src/agent/think-thread-agent";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";

/**
 * The DO-storage round-trip and durability behaviour for a pending model
 * switch — the same class of composer state as the draft, and tested the
 * same way `thread-draft.integration.test.ts` tests the draft. What this
 * proves that `pending-model-switch.test.ts` (unit, duck-typed `this`, a
 * hand-rolled Map for storage) cannot: that the value written by one instance
 * is read back correctly by a genuinely different `ThinkThreadAgent` instance
 * over the SAME durable storage, and that the validation path exercises the
 * real `resolveThreadModelSnapshotValue` + `isUsableProviderForWorkspace`
 * against a real registry DB rather than stubs.
 */
describe("pending model switch persistence", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  it("stores a validated selection, reads it back, and clears", async () => {
    const { threadId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId: "thr_pending_switch",
    });
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));

    await runInDurableObject(stub, async (agent: ThinkThreadAgent) => {
      expect(await agent.getPendingModelSwitch()).toBeNull();

      const result = await agent.setPendingModelSwitch({
        provider: "mock-tool-call",
        model: "mock-model-2",
      });
      expect(result).toMatchObject({
        ok: true,
        value: { provider: "mock-tool-call", model: "mock-model-2" },
      });
      expect(await agent.getPendingModelSwitch()).toMatchObject({
        provider: "mock-tool-call",
        model: "mock-model-2",
      });

      await agent.clearPendingModelSwitch();
      expect(await agent.getPendingModelSwitch()).toBeNull();
    });
  });

  it("survives a fresh instance reading the same storage", async () => {
    const { threadId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId: "thr_pending_switch_fresh",
    });
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));

    await runInDurableObject(stub, async (agent: ThinkThreadAgent, state) => {
      await agent.setPendingModelSwitch({ provider: "mock-tool-call", model: "mock-model-2" });

      // A genuinely new instance over the SAME DO state — proves the value
      // came from storage, not from any in-memory cache on `agent`.
      const rehydrated = new ThinkThreadAgent(state, env);
      expect(await rehydrated.getPendingModelSwitch()).toMatchObject({
        provider: "mock-tool-call",
        model: "mock-model-2",
      });
    });
  });

  it("rejects a provider the workspace cannot use and stores nothing", async () => {
    const { threadId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId: "thr_pending_switch_rejected",
    });
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));

    await runInDurableObject(stub, async (agent: ThinkThreadAgent) => {
      const result = await agent.setPendingModelSwitch({ provider: "not-a-provider", model: "x" });
      expect(result.ok).toBe(false);
      expect(await agent.getPendingModelSwitch()).toBeNull();
    });
  });
});
