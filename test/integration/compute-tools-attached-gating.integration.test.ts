/**
 * `confirm_workbench_switch` must be hidden from an attached subagent — its
 * own thread row never has a pending switch, so the call could only fail and
 * waste tokens / confuse the model. `select_sandbox_package`, the tool this
 * replaced, was gated the same way (on `attachedRuntime`).
 *
 * Drives `createComputeTools` (not `buildComputeToolDefs` directly) over a real
 * D1-backed workspace + thread and a REAL session on the thread's
 * `AgentSandbox`, because the gate under test lives in `createComputeTools`'s
 * call to `buildComputeToolDefs` — `hasBlockingWork` is unconditionally present
 * on the tool deps (see `think-thread-agent.ts`'s `computeToolDeps()`), so a
 * test that stubs `buildComputeToolDefs` directly could never see this
 * regression.
 *
 * The backend is the in-memory fake, installed through the thread-keyed host
 * override registry — the seam that survives the service living in another DO,
 * since a `buildBackend` closure cannot cross an RPC boundary.
 */
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createComputeTools, type ComputeToolDeps } from "../../src/agent/compute-tools";
import { openSandboxSession } from "../../src/compute/agent-sandbox-client";
import { FakeComputeBackend } from "../../src/compute/backends/fake";
import {
  clearComputeHostTestOverrides,
  setComputeHostTestOverrides,
} from "../../src/compute/host-test-overrides";
import type { BackendReference } from "../../src/compute/backend";
import type { Env } from "../../src/env";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";

const NOW = 1_800_000_000_000;

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

function baseToolDeps(threadId: string, attachedRuntime?: BackendReference): ComputeToolDeps {
  return {
    env: env as unknown as Env,
    threadId,
    supportsProcessMonitor: false,
    backgroundLongRunningExec: false,
    now: () => NOW,
    // Set unconditionally, exactly as `computeToolDeps()` does — the gate
    // under test must NOT rely on this being absent for subagents.
    hasBlockingWork: async () => false,
    adoptCommittedResourceProfile: async () => {},
    ...(attachedRuntime ? { attachedRuntime } : {}),
  };
}

/** Opens the real session the thread DO would open, with the fake backend installed. */
async function toolsFor(
  threadId: string,
  runtimeConfig: { workspaceId: string; agentId: string },
  attachedRuntime?: BackendReference,
) {
  setComputeHostTestOverrides(threadId, {
    buildBackend: async () => new FakeComputeBackend(),
    now: () => NOW,
  });
  try {
    const session = await openSandboxSession(env as unknown as Env, threadId, {
      supportsProcessMonitor: false,
      runtimeConfig,
      ...(attachedRuntime ? { attachedRuntime } : {}),
    });
    expect(session, "compute must be enabled for this thread").not.toBeNull();
    return await createComputeTools(session, baseToolDeps(threadId, attachedRuntime));
  } finally {
    clearComputeHostTestOverrides(threadId);
  }
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

    const tools = await toolsFor(threadId, { workspaceId, agentId });
    expect(tools.confirm_workbench_switch).toBeDefined();
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

    const tools = await toolsFor(threadId, { workspaceId, agentId }, attachedRuntime);
    expect(tools.confirm_workbench_switch).toBeUndefined();
    // Sanity: the rest of the compute surface is unaffected by the gate.
    expect(tools.exec).toBeDefined();
  });
});
