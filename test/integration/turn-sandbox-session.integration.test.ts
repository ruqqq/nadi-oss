/**
 * Two invariants the cutover created and that nothing else can see.
 *
 * 1. THE TURN'S SESSION IS NEVER STALE. `_turnSandbox` holds an RPC stub across
 *    `beforeTurn` -> `beforeStep` -> `onChatResponse`. That is one invocation,
 *    which is what makes holding it legal at all — but only if a turn can never
 *    read the PREVIOUS turn's value. `beforeTurn` used to assign the field only
 *    on success, so a turn whose open FAILED left the last turn's stub readable
 *    by this turn's `beforeStep`, where every call on it rejects with
 *    "RPC stub used after being disposed." and kills the turn.
 *
 * 2. AUTOMATIC REPOSITORY PREPARATION STILL RUNS. `onFreshRuntimeAcquired`
 *    fires from INSIDE `readOrAcquireRuntime`, so in `AgentSandbox` it cannot
 *    re-enter `resolveComputeService` (it would wait on the acquire that is
 *    waiting on it). It is broken by a `{service|null}` holder stamped when the
 *    resolve returns — and a broken holder FAILS SILENTLY, because
 *    `thread-service.ts` swallows preparation failure. Nothing acquired a fresh
 *    runtime through `AgentSandbox` until this file, so nothing would have
 *    noticed.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { ThinkThreadAgent } from "../../src/agent/think-thread-agent";
import type { SandboxSessionResolution } from "../../src/compute/agent-sandbox-client";
import { FakeComputeBackend } from "../../src/compute/backends/fake";
import {
  clearComputeHostTestOverrides,
  setComputeHostTestOverrides,
} from "../../src/compute/host-test-overrides";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";
import { agentClonePath } from "../../src/compute/workspace-layout";

const NOW = 1_800_000_000_000;

/**
 * A structural view, not an intersection with `ThinkThreadAgent`: `_turnSandbox`
 * is private, and intersecting a private member reduces the whole type to
 * `never`.
 */
type TestableAgent = {
  __unsafe_ensureInitialized(): Promise<void>;
  beforeTurnProbeForTest(): Promise<unknown>;
  beforeStep(ctx: { stepNumber: number }): Promise<unknown>;
  resolveComputeServiceForTest(): Promise<SandboxSessionResolution | null>;
  _turnSandbox: SandboxSessionResolution | null;
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

describe("the turn's sandbox session", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  it("is cleared by a FAILED beforeTurn, so beforeStep never touches the last turn's stub", async () => {
    const threadId = "thr_turn_session_stale";
    const { workspaceId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId,
      runtime: "think",
    });
    await seedComputeEnabledWorkspace(workspaceId);

    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));
    const result = await runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
      const agent = instance as unknown as TestableAgent;
      await agent.__unsafe_ensureInitialized();

      // Stand in for the PREVIOUS turn's session, left on the field. Every
      // method records instead of throwing, so the assertion below reports "it
      // was used" rather than a disposed-stub error that could come from
      // anywhere.
      const staleCalls: string[] = [];
      const stale = new Proxy(
        {},
        {
          get: (_t, property) =>
            typeof property === "string" && property !== "then"
              ? async () => {
                  staleCalls.push(property);
                  return undefined;
                }
              : undefined,
        },
      ) as SandboxSessionResolution["service"];
      agent._turnSandbox = {
        service: stale,
        workspaceId,
        config: null as unknown as SandboxSessionResolution["config"],
      };

      // Break the OPEN, not the thread: the backend refuses to construct, so
      // `session()` encodes a failure and `openSandboxSession` throws out of
      // `beforeTurn`'s wave — exactly the shape a transient resolve failure has.
      setComputeHostTestOverrides(threadId, {
        buildBackend: async () => {
          throw new Error("backend_unavailable: induced");
        },
        now: () => NOW,
      });
      let beforeTurnThrew = false;
      try {
        await agent.beforeTurnProbeForTest();
      } catch {
        beforeTurnThrew = true;
      } finally {
        clearComputeHostTestOverrides(threadId);
      }

      const fieldAfterFailure = agent._turnSandbox;
      await agent.beforeStep({ stepNumber: 0 });
      return { beforeTurnThrew, fieldAfterFailure, staleCalls };
    });

    // ANTI-VACUITY: the failure this is about actually happened, and the field
    // really was cleared rather than never set.
    expect(result.beforeTurnThrew, "beforeTurn must have failed for this to test anything").toBe(
      true,
    );
    expect(result.fieldAfterFailure).toBeNull();
    expect(
      result.staleCalls,
      "beforeStep called the PREVIOUS turn's session — post-cutover that stub is disposed",
    ).toEqual([]);
  });

  it("acquiring a fresh runtime through AgentSandbox runs repository preparation", async () => {
    const threadId = "thr_turn_session_prep";
    const { workspaceId, agentId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId,
      runtime: "think",
    });
    await seedComputeEnabledWorkspace(workspaceId);
    // A repository on the thread's own AGENT, or `createRepositoryPreparation`
    // takes its "nothing configured" exit and the whole test would pass without
    // the reentrancy holder working at all.
    //
    // The row is keyed on `agent_id` and NOTHING re-points it here: this is the
    // end-to-end assertion that the column's values and every reader's key moved
    // together. Key it on anything else and `git clone` disappears from the
    // command list below, with no error raised anywhere.
    await env.REGISTRY_DB.prepare(
      `INSERT INTO agent_repositories
        (id, agent_id, source, name, url, default_branch, checkout_path_name, created_at)
       VALUES (?, ?, 'url', 'nadi', 'https://example.test/nadi.git', 'main', 'nadi', ?)`,
    )
      .bind(`agr_${threadId}`, agentId, NOW)
      .run();

    const backend = new FakeComputeBackend();
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));
    const commands = await runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
      const agent = instance as unknown as TestableAgent;
      await agent.__unsafe_ensureInitialized();
      setComputeHostTestOverrides(threadId, { buildBackend: async () => backend });
      try {
        const session = await agent.resolveComputeServiceForTest();
        expect(session, "compute must be enabled for this thread").not.toBeNull();
        // The FRESH acquire. `onFreshRuntimeAcquired` fires from INSIDE it,
        // while the acquisition is still in flight — the exact position where a
        // service that re-entered `boundedAcquisition` would deadlock until the
        // 25s acquire deadline, cloning nothing and logging nothing.
        await session!.service.ensureRuntimeReference();
        return [
          ...backend.startProcessCalls.map((call) => call.command),
          ...backend.runCommandCalls.map((call) => call.command),
        ];
      } finally {
        clearComputeHostTestOverrides(threadId);
      }
    });

    // The acquire itself runs NO commands, so every one of these came from
    // `prepareRepositories` having resolved a usable service from inside it.
    // Both halves matter: the work-root command proves preparation started, and
    // the per-repository probe proves it reached the snapshot loop rather than
    // failing out after its first call.
    expect(
      commands.some((command) => command.includes("mkdir -p /workspace")),
      `expected the work-root preparation; commands were ${JSON.stringify(commands)}`,
    ).toBe(true);
    // The AGENT's clone is what gets probed — one per box, under `repos/`.
    expect(
      commands.some((command) => command.includes(agentClonePath("nadi"))),
      `expected the agent's checkout to be probed; commands were ${JSON.stringify(commands)}`,
    ).toBe(true);
  });
});
