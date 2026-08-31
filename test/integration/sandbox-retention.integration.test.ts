/**
 * END-TO-END coverage that the retention pieces from Tasks 1-4 are actually
 * WIRED together, through a real ThinkThreadAgent Durable Object over real DO
 * SQLite and a real D1-backed registry. Tasks 1-4 each proved their own piece
 * against fakes (a hand-built two-key `ComputeToolHostDeps`, or a
 * `createService()` fixture in the unit suite) — none of those can observe
 * whether `sandboxHostDeps()` in `think-thread-agent.ts` actually plumbs
 * `markSandboxDirty` into every write path, or whether the `confirm_work_saved`
 * tool returned by the REAL `buildComputeToolDefs` map talks to the REAL
 * `ThreadComputeService.releaseIfIdle()`. This file drives exactly that seam.
 *
 * Only the compute BACKEND is a fake (`FakeComputeBackend`): there is no live
 * compute provider in the test environment, and `runCommand`'s configurable
 * `nextProcessResult` is used to script the git-porcelain output the real
 * `probeWorkspaceCleanliness` parser expects, matching this file's own
 * `PROBE_SCRIPT` tab-separated line format. Everything else — the DO storage
 * bit, the tool wiring, the service's idle-release decision — is real.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { ThinkThreadAgent } from "../../src/agent/think-thread-agent";
import { createComputeTools, type ComputeToolHostDeps } from "../../src/agent/compute-tools";
import { FakeComputeBackend } from "../../src/compute/backends/fake";
import {
  clearComputeHostTestOverrides,
  setComputeHostTestOverrides,
} from "../../src/compute/host-test-overrides";
import type { ThreadComputeService } from "../../src/compute/thread-service";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";

const NOW = 1_800_000_000_000;
const IDLE_TIMEOUT_MS = 900_000;

/** Matches the DO-internal test hooks think-thread-agent.ts exposes for exactly this purpose. */
type TestableAgent = ThinkThreadAgent & {
  __unsafe_ensureInitialized(): Promise<void>;
  resolveComputeServiceForTest(): Promise<{ service: ThreadComputeService } | null>;
  getSandboxDeclaredClean(): Promise<boolean>;
  setSandboxDeclaredClean(clean: boolean): Promise<void>;
};

/**
 * The real host deps `createComputeTools` (and every model-facing tool) is
 * built from. Reached the same way `test/integration/work-ledger.integration.test.ts`
 * reaches it: an unsafe cast onto the instance, not a reimplementation.
 */
function hostDepsOf(instance: ThinkThreadAgent): ComputeToolHostDeps {
  return (instance as unknown as { sandboxHostDeps(): ComputeToolHostDeps }).sandboxHostDeps();
}

async function seedComputeEnabledWorkspace(
  workspaceId: string,
  provider: "cloudflare" | "mock" = "cloudflare",
) {
  await env.REGISTRY_DB.prepare(
    `INSERT INTO workspace_sandbox_settings
      (workspace_id, enabled, provider, provider_config_json,
       image, idle_timeout_ms, recovery_ttl_ms, max_process_runtime_ms, limits_json,
       network_restriction_enabled, network_domain_allowlist)
     VALUES (?, 1, ?, ?, '', ?, 86400000, 600000, '{}', 0, '')`,
  )
    .bind(workspaceId, provider, JSON.stringify({ kind: provider }), IDLE_TIMEOUT_MS)
    .run();
}

/** A dirty-repo line in the tab-separated shape `workspace-cleanliness.ts` parses. */
const DIRTY_PROBE_STDOUT = "/workspace/app\t M a.txt|\t0\n";

function stubFor(threadId: string) {
  return env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));
}

describe("sandbox retention loop (DO + D1 integration)", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  it("declaring clean then writing again re-arms preservation", async () => {
    // The whole point of the bit: a declaration only covers the state it was
    // made about. If a write after the declaration didn't clear it, a stale
    // "clean" would authorize discarding work the model never verified.
    const threadId = "thr_retention_rearm";
    const { workspaceId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId,
      runtime: "think",
    });
    // Approach: the D1 `mock` provider. Nothing here needs a scripted backend
    // response or a backend call log — only that a REAL write path runs and
    // clears the bit — so the in-memory provider the deployment itself can
    // select expresses it, and no test seam is needed at all.
    await seedComputeEnabledWorkspace(workspaceId, "mock");

    const stub = stubFor(threadId);
    await runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
      const testInstance = instance as TestableAgent;
      await testInstance.__unsafe_ensureInitialized();

      const resolved = await testInstance.resolveComputeServiceForTest();
      expect(resolved).not.toBeNull();
      await resolved!.service.ensureRuntimeReference();

      await testInstance.setSandboxDeclaredClean(true);
      expect(await testInstance.getSandboxDeclaredClean()).toBe(true);

      await resolved!.service.exec({ command: "echo hi > /workspace/new.txt" });

      expect(await testInstance.getSandboxDeclaredClean()).toBe(false);
    });
  });

  it("a dirty workspace refuses the declaration and stays preserved", async () => {
    const threadId = "thr_retention_dirty";
    const { workspaceId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId,
      runtime: "think",
    });
    await seedComputeEnabledWorkspace(workspaceId);

    const stub = stubFor(threadId);
    try {
      await runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
        const testInstance = instance as TestableAgent;
        await testInstance.__unsafe_ensureInitialized();
        const backend = new FakeComputeBackend();
        let nowValue = NOW;
        // Approach: the thread-keyed host-override registry. The `mock` provider
        // cannot express EITHER half of this test — it has no way to script the
        // git-porcelain stdout `probeWorkspaceCleanliness` parses, and it records
        // no `releaseCalls` for the idle-release disposition assertion — so the
        // instrumented fake stays, reached through a seam that survives the
        // service moving into `AgentSandbox`.
        setComputeHostTestOverrides(threadId, {
          buildBackend: async () => backend,
          now: () => nowValue,
        });

        const resolved = await testInstance.resolveComputeServiceForTest();
        expect(resolved).not.toBeNull();
        await resolved!.service.ensureRuntimeReference();

        // Drive the REAL confirm_work_saved from the REAL buildComputeToolDefs
        // map (via createComputeTools), not a hand-built stand-in.
        const tools = await createComputeTools(hostDepsOf(instance));
        expect(tools).toHaveProperty("confirm_work_saved");

        backend.setNextProcessResult({ status: "exited", exitCode: 0, stdout: DIRTY_PROBE_STDOUT });
        const message = await (
          tools.confirm_work_saved as {
            execute: (input: unknown, options: unknown) => Promise<unknown>;
          }
        ).execute({}, { toolCallId: "t1", messages: [] });

        expect(String(message)).toContain("/workspace/app");
        expect(String(message)).toContain("a.txt");
        expect(await testInstance.getSandboxDeclaredClean()).toBe(false);

        // Idle-release must reach the SAME conclusion the tool just refused:
        // preserved, not discarded.
        nowValue += IDLE_TIMEOUT_MS;
        backend.setNextProcessResult({ status: "exited", exitCode: 0, stdout: DIRTY_PROBE_STDOUT });
        await resolved!.service.releaseIfIdle();
        expect(backend.releaseCalls.at(-1)?.options.disposition).toBe("recoverable");
      });
    } finally {
      // Scoped to the ONE thread this test registered. A blanket clear would
      // reach across files: `integration-fast` runs `isolate: false`, so the
      // override map is shared by every file in the project run.
      clearComputeHostTestOverrides(threadId);
    }
  });
});
