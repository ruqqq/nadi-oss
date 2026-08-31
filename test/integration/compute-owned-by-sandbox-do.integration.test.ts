/**
 * THE SPLIT-BRAIN ASSERTION.
 *
 * The compute service is owned by the `AgentSandbox` Durable Object, and by it
 * ALONE. If some callers resolved against `AgentSandbox`'s storage while others
 * still resolved against the thread DO's own, one thread would carry two
 * `compute_state` rows in two DOs pointing at two different provider sandboxes:
 * the model's `exec` running on one machine while the alarm polls and evicts the
 * other. That is data loss, not an intermediate state — so this file asserts
 * BOTH halves after a real model-facing tool runs a real command:
 *
 *   1. the `AgentSandbox` DO for this thread HAS a `compute_state` row, and
 *   2. the thread's own DO storage has NO `compute_state` rows at all.
 *
 * Half 2 is the one that catches a partial cutover, and it is deliberately
 * "zero rows", not "no ACTIVE row": a thread-local store that is merely unused
 * this tick is still a second brain waiting to be written to.
 *
 * The tool is reached through `computeToolsForTest()`, which builds the tool set
 * exactly as `beforeTurn` does — so what is under test is the production
 * wiring, not a stand-in the test assembled itself.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { ToolSet } from "ai";
import type { ThinkThreadAgent } from "../../src/agent/think-thread-agent";
import type { AgentSandbox } from "../../src/compute/agent-sandbox-do";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";

type TestableAgent = ThinkThreadAgent & {
  __unsafe_ensureInitialized(): Promise<void>;
  computeToolsForTest(): Promise<ToolSet>;
};

async function seedComputeEnabledWorkspace(workspaceId: string) {
  await env.REGISTRY_DB.prepare(
    `INSERT INTO workspace_sandbox_settings
      (workspace_id, enabled, provider, provider_config_json,
       image, idle_timeout_ms, recovery_ttl_ms, max_process_runtime_ms, limits_json,
       network_restriction_enabled, network_domain_allowlist)
     VALUES (?, 1, 'mock', ?, '', 900000, 86400000, 600000, '{}', 0, '')`,
  )
    .bind(workspaceId, JSON.stringify({ kind: "mock" }))
    .run();
}

/**
 * How many `compute_state` rows this DO's SQLite holds. A DO that never built a
 * store has no such TABLE, which is the answer "zero" in its strongest form —
 * so a missing table reads as 0 rather than as an error.
 */
function computeStateRowCount(storage: DurableObjectStorage): number {
  const tables = storage.sql
    .exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'compute_state'",
    )
    .toArray();
  if (tables.length === 0) return 0;
  return storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM compute_state").one().n ?? 0;
}

function storageOf(instance: { ctx: { storage: DurableObjectStorage } }): DurableObjectStorage {
  return instance.ctx.storage;
}

describe("compute state lives in AgentSandbox, and only there", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  it("a tool's command writes compute state to the sandbox DO and none to the thread DO", async () => {
    const threadId = "thr_split_brain";
    const { workspaceId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId,
      runtime: "think",
    });
    // The `mock` provider is a real, deployment-selectable backend, so nothing
    // here is a test seam: the command genuinely runs and a runtime is
    // genuinely acquired, which is what puts a row in `compute_state`.
    await seedComputeEnabledWorkspace(workspaceId);

    const threadStub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));
    await runInDurableObject(threadStub, async (instance: ThinkThreadAgent) => {
      const testInstance = instance as TestableAgent;
      await testInstance.__unsafe_ensureInitialized();
      const tools = await testInstance.computeToolsForTest();
      expect(tools.exec, "compute tools must be enabled for this thread").toBeDefined();
      await tools.exec!.execute!({ command: "echo split-brain" }, {} as never);
    });

    // `idFromName` for AGENT_SANDBOX (a plain DurableObject with no onStart) —
    // deliberately NOT getAgentByName, which is right only for the thread DO.
    const sandboxStub = env.AGENT_SANDBOX.get(env.AGENT_SANDBOX.idFromName(threadId));
    const sandboxRows = await runInDurableObject(sandboxStub, (instance: AgentSandbox) =>
      computeStateRowCount(
        storageOf(instance as unknown as { ctx: { storage: DurableObjectStorage } }),
      ),
    );
    expect(sandboxRows, "the AgentSandbox DO must own the thread's compute state").toBe(1);

    const threadRows = await runInDurableObject(threadStub, (instance: ThinkThreadAgent) =>
      computeStateRowCount(
        storageOf(instance as unknown as { ctx: { storage: DurableObjectStorage } }),
      ),
    );
    expect(
      threadRows,
      "the thread DO must hold NO compute state — a second row here is a split brain: " +
        "two sandboxes, exec on one and eviction on the other",
    ).toBe(0);
  });
});
