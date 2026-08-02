/**
 * `confirm_workbench_switch` must be hidden from an attached subagent — its
 * own thread row never has a pending switch, so the call could only fail and
 * waste tokens / confuse the model. `select_sandbox_package`, the tool this
 * replaced, was gated the same way (on `attachedRuntime`).
 *
 * Drives `createComputeTools` (not `buildComputeToolDefs` directly) over a
 * real D1-backed workspace + thread and a real DO's storage, because the
 * gate under test lives in `createComputeTools`'s call to
 * `buildComputeToolDefs` — `hasBlockingWork` is unconditionally present on
 * `ComputeToolHostDeps` (see `think-thread-agent.ts`'s `sandboxHostDeps()`),
 * so a test that stubs `buildComputeToolDefs` directly could never see this
 * regression.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { ThreadAgentV2 } from "../../src/agent/thread-agent";
import { createComputeTools, type ComputeToolHostDeps } from "../../src/agent/compute-tools";
import { FakeComputeBackend } from "../../src/compute/backends/fake";
import type { BackendReference } from "../../src/compute/backend";
import type { Env } from "../../src/env";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";

const NOW = 1_800_000_000_000;

function storageOf(agent: ThreadAgentV2): DurableObjectStorage {
  return (agent as unknown as { ctx: { storage: DurableObjectStorage } }).ctx.storage;
}

async function seedComputeEnabledWorkspace(workspaceId: string) {
  await env.REGISTRY_DB.prepare(
    `INSERT INTO workspace_sandbox_settings
      (workspace_id, enabled, provider, provider_config_json,
       image, idle_timeout_ms, recovery_ttl_ms, max_process_runtime_ms, limits_json,
       network_restriction_enabled, network_domain_allowlist)
     VALUES (?, 1, 'cloudflare', ?, '', 900000, 86400000, 600000, '{}', 0, '')`,
  )
    .bind(workspaceId, JSON.stringify({ kind: "cloudflare" }))
    .run();
}

function baseDeps(
  threadId: string,
  workspaceId: string,
  agentId: string,
  storage: DurableObjectStorage,
  attachedRuntime?: BackendReference,
): ComputeToolHostDeps {
  return {
    env: env as unknown as Env,
    threadId,
    storage,
    resolveRuntimeConfig: async () => ({ workspaceId, agentId }),
    scheduleEviction: async () => {},
    cancelEviction: async () => {},
    deliverSystemReminder: async () => {},
    supportsProcessMonitor: false,
    buildBackend: async () => new FakeComputeBackend(),
    now: () => NOW,
    // Set unconditionally, exactly as `sandboxHostDeps()` does — the gate
    // under test must NOT rely on this being absent for subagents.
    hasBlockingWork: async () => false,
    ...(attachedRuntime ? { attachedRuntime } : {}),
  };
}

describe("createComputeTools confirm_workbench_switch attached-runtime gating", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  it("exposes confirm_workbench_switch to the owning thread", async () => {
    const threadId = "thr_gating_owner";
    const { workspaceId, agentId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId,
      runtime: "think",
    });
    await seedComputeEnabledWorkspace(workspaceId);

    const stub = env.THREAD_AGENT.get(env.THREAD_AGENT.idFromName(threadId));
    await runInDurableObject(stub, async (agent: ThreadAgentV2) => {
      const storage = storageOf(agent);
      const tools = await createComputeTools(baseDeps(threadId, workspaceId, agentId, storage));
      expect(tools.confirm_workbench_switch).toBeDefined();
    });
  });

  it("hides confirm_workbench_switch from an attached subagent", async () => {
    const threadId = "thr_gating_subagent";
    const { workspaceId, agentId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId,
      runtime: "think",
    });
    await seedComputeEnabledWorkspace(workspaceId);

    const attachedRuntime: BackendReference = {
      provider: "cloudflare",
      version: 1,
      payload: { containerId: "container-gating-subagent" },
    };

    const stub = env.THREAD_AGENT.get(env.THREAD_AGENT.idFromName(threadId));
    await runInDurableObject(stub, async (agent: ThreadAgentV2) => {
      const storage = storageOf(agent);
      const tools = await createComputeTools(
        baseDeps(threadId, workspaceId, agentId, storage, attachedRuntime),
      );
      expect(tools.confirm_workbench_switch).toBeUndefined();
      // Sanity: the rest of the compute surface is unaffected by the gate.
      expect(tools.exec).toBeDefined();
    });
  });
});
