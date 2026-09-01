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
import { agentClonePath, threadWorktreePath } from "../../src/compute/workspace-layout";

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

  /**
   * H1: EVERY thread of the agent gets a worktree, not just the one that woke
   * the box.
   *
   * Preparation used to hang off `onFreshRuntimeAcquired`, which fires only on
   * `absent -> active`. The compute store belongs to the AGENT's sandbox DO, so
   * "active" is BOX-wide: the second thread of an agent found the runtime
   * already up, ran no preparation at all, and got a working directory that
   * `ensureWorkspaceRootOnce` had dutifully created and nothing had put code in.
   * No error, no skip entry, no log line — the swallowed-zero-repository shape
   * this whole path exists to make impossible, reachable on the happy path.
   *
   * Both threads are asserted, and thread A's assertions are the anti-vacuity
   * half: if the wiring broke such that NOBODY prepared, A goes red too and the
   * result reads as a broken test rather than a passing one.
   */
  it("prepares EVERY thread of one agent, not only the one that woke the box", async () => {
    const workspaceId = "ws_turn_session_two_threads";
    const agentId = "agent_turn_session_two_threads";
    const threadA = "thr_turn_two_a";
    const threadB = "thr_turn_two_b";
    for (const threadId of [threadA, threadB]) {
      await seedRegistryThread(env.REGISTRY_DB, {
        threadId,
        workspaceId,
        agentId,
        runtime: "think",
      });
    }
    await seedComputeEnabledWorkspace(workspaceId);
    await env.REGISTRY_DB.prepare(
      `INSERT INTO agent_repositories
        (id, agent_id, source, name, url, default_branch, checkout_path_name, created_at)
       VALUES (?, ?, 'url', 'nadi', 'https://example.test/nadi.git', 'main', 'nadi', ?)`,
    )
      .bind(`agr_${agentId}`, agentId, NOW)
      .run();

    // ONE backend for both threads — one agent, one box. This is what makes the
    // second thread's runtime already-active by the time it opens.
    const backend = new FakeComputeBackend();
    const commandsFor = async (threadId: string) => {
      const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));
      return runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
        const agent = instance as unknown as TestableAgent;
        await agent.__unsafe_ensureInitialized();
        setComputeHostTestOverrides(threadId, { buildBackend: async () => backend });
        try {
          const before = backend.startProcessCalls.length + backend.runCommandCalls.length;
          const session = await agent.resolveComputeServiceForTest();
          expect(session, "compute must be enabled for this thread").not.toBeNull();
          await session!.service.ensureRuntimeReference();
          return [
            ...backend.startProcessCalls.map((call) => call.command),
            ...backend.runCommandCalls.map((call) => call.command),
          ].slice(before);
        } finally {
          clearComputeHostTestOverrides(threadId);
        }
      });
    };

    // WHAT IS ASSERTED, and why it stops here. `FakeComputeBackend` answers every
    // command with exit 0 and empty stdout, so `remote get-url origin` comes back
    // blank and preparation skips this repository as "remote does not match"
    // before it reaches `worktree add`. The clone/worktree COMMANDS are pinned in
    // `test/unit/agent/repository-preparation.test.ts`, against a scripted shell.
    // What only this test can see is whether preparation RUNS AT ALL for a thread
    // that did not wake the box — and before the fix, thread B issued not one
    // command.
    const first = await commandsFor(threadA);
    expect(
      first.some((command) => command.includes(`/workspace/threads/${threadA}`)),
      `thread A must prepare its own directory; commands were ${JSON.stringify(first)}`,
    ).toBe(true);
    expect(first.some((command) => command.includes(agentClonePath("nadi")))).toBe(true);

    const second = await commandsFor(threadB);
    // The runtime is ALREADY ACTIVE here — no second acquire, so
    // `onFreshRuntimeAcquired` cannot fire and cannot be what prepares this one.
    expect(
      second.some((command) => command.includes(`/workspace/threads/${threadB}`)),
      `thread B must prepare its own directory off the already-active box; commands were ${JSON.stringify(second)}`,
    ).toBe(true);
    expect(
      second.some((command) => command.includes(agentClonePath("nadi"))),
      `thread B must probe the agent's clone; commands were ${JSON.stringify(second)}`,
    ).toBe(true);
    // Thread A's own preparation must not be what thread B is reading: B's
    // commands name B's directory and never A's.
    expect(second.some((command) => command.includes(threadWorktreePath(threadA, "nadi")))).toBe(
      false,
    );
  });

  /**
   * The gate that makes "prepare on every turn" affordable, and the one event
   * that must defeat it.
   *
   * Preparation now runs from the first `exec` of every session, so without a
   * marker every turn would re-run each repository's `setupCommand` and the
   * agent's `setupScript`. With a marker that never cleared, a box that was
   * DESTROYED (fresh `/workspace`, nothing in it) would be read as prepared and
   * the thread would work in an empty directory — the same failure, arrived at
   * from the other side. Both halves are asserted here because each one alone
   * looks correct.
   */
  it("prepares once per box, and again after the box is destroyed", async () => {
    const threadId = "thr_turn_prep_gate";
    // Explicit workspace AND agent ids: `integration-fast` runs `isolate: false`
    // and `seedRegistryThread` defaults every thread onto `agent-workspace-test`
    // — one AgentSandbox DO, one compute store, shared with every other case in
    // the project. This test DESTROYS its box, which would strand any neighbour
    // sharing it on a runtime reference the backend no longer knows.
    const workspaceId = "ws_turn_prep_gate";
    const agentId = "agent_turn_prep_gate";
    await seedRegistryThread(env.REGISTRY_DB, {
      threadId,
      workspaceId,
      agentId,
      runtime: "think",
    });
    await seedComputeEnabledWorkspace(workspaceId);
    // A SETUP SCRIPT rather than a repository, and that choice is the test's
    // one compromise. `FakeComputeBackend` answers every command with exit 0 and
    // empty stdout, so a repository's `remote get-url origin` comes back blank
    // and preparation SKIPS it — and a skipped run is deliberately never marked
    // prepared, so a repository fixture could never reach the gate at all. The
    // setup-script path completes cleanly and marks, which is what the gate is.
    await env.REGISTRY_DB.prepare("UPDATE agents SET setup_script = ? WHERE id = ?")
      .bind("echo prepared", agentId)
      .run();

    const backend = new FakeComputeBackend();
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));
    const openAndCount = async (shutdownAfter = false) =>
      runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
        const agent = instance as unknown as TestableAgent;
        await agent.__unsafe_ensureInitialized();
        setComputeHostTestOverrides(threadId, { buildBackend: async () => backend });
        try {
          const before = backend.runCommandCalls.length + backend.startProcessCalls.length;
          const session = await agent.resolveComputeServiceForTest();
          await session!.service.ensureRuntimeReference();
          const after = backend.runCommandCalls.length + backend.startProcessCalls.length;
          if (shutdownAfter) await session!.service.execShutdown();
          return after - before;
        } finally {
          clearComputeHostTestOverrides(threadId);
        }
      });

    // First session on a fresh box: preparation runs.
    expect(await openAndCount()).toBeGreaterThan(0);
    // Second session, same box, same configuration: not one command. This is
    // what a per-turn trigger costs without the marker.
    expect(await openAndCount(true)).toBe(0);
    // The box is gone — `/workspace` is empty on the next acquire, so every
    // marker describes a directory that no longer exists.
    expect(await openAndCount()).toBeGreaterThan(0);
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
