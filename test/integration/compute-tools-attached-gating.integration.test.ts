/**
 * `confirm_work_saved` must be hidden from an attached subagent: it shares the
 * parent's runtime, so letting it declare the parent's sandbox discardable
 * would destroy the parent's work.
 *
 * Drives `createComputeTools` (not `buildComputeToolDefs` directly) over a real
 * D1-backed workspace + thread and a REAL session on the thread's
 * `AgentSandbox`, because the gate under test lives in `createComputeTools`'s
 * call to `buildComputeToolDefs` — `setSandboxDeclaredClean` is unconditionally
 * present on the tool deps (see `think-thread-agent.ts`'s `computeToolDeps()`),
 * so a test that stubs `buildComputeToolDefs` directly could never see this
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
import { threadWorkRoot, WORKSPACE_ROOT } from "../../src/compute/workspace-layout";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";

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
    // Set unconditionally, exactly as `computeToolDeps()` does — the gate
    // under test must NOT rely on this being absent for subagents.
    setSandboxDeclaredClean: async () => {},
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
  });
  try {
    const session = await openSandboxSession(env as unknown as Env, threadId, {
      workspaceThreadId: threadId,
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

describe("createComputeTools confirm_work_saved attached-runtime gating", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  it("exposes confirm_work_saved to the owning thread", async () => {
    const threadId = "thr_gating_owner";
    const { workspaceId, agentId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId,
      workspaceId: "ws_gating_owner",
      agentId: "agent_gating_owner",
      runtime: "think",
    });
    await seedComputeEnabledWorkspace(workspaceId);

    const tools = await toolsFor(threadId, { workspaceId, agentId });
    expect(tools.confirm_work_saved).toBeDefined();
  });

  /**
   * SCOPE, WHICH NO TEST COVERED. `/workspace` is the AGENT's box since P3, so
   * the box-wide probe made `confirm_work_saved` answer about SIBLING threads:
   * thread A was refused because thread B had uncommitted work, and B's
   * repository paths were returned to A's model to explain why — a wrong
   * verdict and a cross-thread leak. Swapping the script back to the box-wide
   * one failed nothing, which is why this exists.
   */
  it("probes only the CALLING thread's directory, never the whole box", async () => {
    const threadId = "thr_gating_probe_scope";
    // ITS OWN WORKSPACE, AND THEREFORE ITS OWN AGENT. `seedRegistryThread`
    // defaults `agentId` to `agent-${workspaceId}` and `workspaceId` to
    // `workspace-test`, so every test that omits both shares ONE agent — and
    // since P3 the sandbox DO is keyed by agent, that means one DO carrying
    // compute state from whichever test acquired first, pointing at a
    // `FakeComputeBackend` instance that no longer exists. Under
    // `isolate: false` this is the only test here that execs, so it is the only
    // one that meets `fake_runtime_not_found`.
    const { workspaceId, agentId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId,
      workspaceId: "ws_gating_probe_scope",
      agentId: "agent_gating_probe_scope",
      runtime: "think",
    });
    await seedComputeEnabledWorkspace(workspaceId);

    const backend = new FakeComputeBackend();
    let toolResult: unknown;
    setComputeHostTestOverrides(threadId, { buildBackend: async () => backend });
    try {
      const session = await openSandboxSession(env as unknown as Env, threadId, {
        workspaceThreadId: threadId,
        supportsProcessMonitor: false,
        runtimeConfig: { workspaceId, agentId },
      });
      const tools = await createComputeTools(session, baseToolDeps(threadId));
      // INSIDE the override's lifetime: the probe is an `exec` that resolves a
      // backend when it runs, not when the tool was built, so clearing first
      // would let a sibling suite's backend answer it under `isolate: false`.
      toolResult = await tools.confirm_work_saved?.execute?.({}, {} as never);
    } finally {
      clearComputeHostTestOverrides(threadId);
    }

    const probe = [...backend.runCommandCalls, ...backend.startProcessCalls]
      .map((call) => call.command)
      .find((command) => command.includes("PROBE"));
    expect(
      probe,
      `confirm_work_saved must have run the cleanliness probe; tool returned ${JSON.stringify(toolResult)}`,
    ).toBeDefined();
    expect(probe).toContain(`root="${threadWorkRoot(threadId)}"`);
    // The box-wide root would sweep every sibling thread's worktree AND the
    // agent's canonical clones.
    expect(probe).not.toContain(`root="${WORKSPACE_ROOT}"`);
  });

  it("hides confirm_work_saved from an attached subagent", async () => {
    const threadId = "thr_gating_subagent";
    const { workspaceId, agentId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId,
      workspaceId: "ws_gating_subagent",
      agentId: "agent_gating_subagent",
      runtime: "think",
    });
    await seedComputeEnabledWorkspace(workspaceId);

    const attachedRuntime: BackendReference = {
      provider: "cloudflare",
      version: 1,
      payload: { containerId: "container-gating-subagent" },
    };

    const tools = await toolsFor(threadId, { workspaceId, agentId }, attachedRuntime);
    expect(tools.confirm_work_saved).toBeUndefined();
    // Sanity: the rest of the compute surface is unaffected by the gate.
    expect(tools.exec).toBeDefined();
  });
});
