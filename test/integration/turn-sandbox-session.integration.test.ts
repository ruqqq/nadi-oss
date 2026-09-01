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
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ThinkThreadAgent } from "../../src/agent/think-thread-agent";
import type { SandboxSessionResolution } from "../../src/compute/agent-sandbox-client";
import { FakeComputeBackend } from "../../src/compute/backends/fake";
import {
  clearComputeHostTestOverrides,
  setComputeHostTestOverrides,
} from "../../src/compute/host-test-overrides";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";
import { log } from "../../src/log";
import {
  PREPARED_GATE_MARKER,
  agentClonePath,
  threadWorktreePath,
} from "../../src/compute/workspace-layout";

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
   * The gate that makes "prepare on the first command of every turn"
   * affordable, and the event that must defeat it.
   *
   * WHAT IS SIMULATED, and what is not. The gate is a real `sh -lc 'test ...'`
   * against the box, which `FakeComputeBackend` cannot execute. Its default for
   * that probe is "not prepared" — an empty fake box IS unprepared, and that
   * default is deliberate so a test cannot acquire "already prepared" by
   * forgetting to say anything. PREPARED is the state a test must state out
   * loud, which is what `scriptedExits` does below. The sentinel's content and
   * placement are asserted in `test/unit/agent/repository-preparation.test.ts`;
   * what only this test can see is that the service HONOURS the answer.
   */
  it("runs nothing when the box says prepared, and everything when it does not", async () => {
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
    // A SETUP SCRIPT rather than a repository: the fake's blank stdout makes a
    // repository's `remote get-url origin` come back empty, so preparation
    // would skip it — and a skipped run is deliberately never recorded. The
    // setup-script path completes cleanly.
    await env.REGISTRY_DB.prepare("UPDATE agents SET setup_script = ? WHERE id = ?")
      .bind("echo prepared", agentId)
      .run();

    const backend = new FakeComputeBackend();
    const PREPARED = { match: PREPARED_GATE_MARKER, exitCode: 0 };
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
          // `confirm: true` is REQUIRED since P3 — an unconfirmed call is a
          // no-op, which would leave this helper's `shutdownAfter` inert and the
          // assertion below passing only because the fake's script was reset.
          if (shutdownAfter) await session!.service.execShutdown({ confirm: true });
          return after - before;
        } finally {
          clearComputeHostTestOverrides(threadId);
        }
      });

    // A box with no sentinel — the fake's default. Preparation runs.
    expect(await openAndCount()).toBeGreaterThan(1);

    // The sentinel now matches: the gate probe, and nothing else. That is what a
    // per-turn trigger would otherwise cost on every turn.
    backend.scriptedExits.push(PREPARED);
    expect(await openAndCount(true)).toBe(1);

    // The box was destroyed, so `/workspace` — and the sentinel inside the
    // thread's own directory — went with it.
    //
    // HONEST BOUND: the fake models the sentinel as a scripted exit queue, not
    // as filesystem state, so what actually drives the assertion below is the
    // empty script — not the destroy. Clearing it is belt-and-braces (the probe
    // above already consumed the entry). This case is therefore evidence that
    // preparation re-runs against a box with no sentinel, NOT evidence that
    // `execShutdown` removed one. Proving the latter needs a fake whose
    // filesystem survives across opens.
    backend.scriptedExits.length = 0;
    expect(await openAndCount()).toBeGreaterThan(1);
  });

  /**
   * NEW-3, at the seam that discards it.
   *
   * A failed setup command is not a skip: the repository cloned, the worktree
   * was added, and the failure is a value inside a `prepared` entry. The caller
   * logged `result.skipped` and threw the rest away, so a `pnpm install` that
   * exited non-zero produced no error, no log line, and — because the run was
   * still recorded as prepared — no retry either. Preparation returns ONE
   * `failures` list now, and the same list decides both questions.
   *
   * Asserted on the LOG because that is the only place the outcome surfaces:
   * nothing throws, and `onFreshRuntimeAcquired`'s successor swallows by design.
   */
  it("logs a failed setup command instead of discarding it", async () => {
    const threadId = "thr_turn_prep_failure";
    const workspaceId = "ws_turn_prep_failure";
    const agentId = "agent_turn_prep_failure";
    await seedRegistryThread(env.REGISTRY_DB, {
      threadId,
      workspaceId,
      agentId,
      runtime: "think",
    });
    await seedComputeEnabledWorkspace(workspaceId);
    await env.REGISTRY_DB.prepare("UPDATE agents SET setup_script = ? WHERE id = ?")
      .bind("exit 3", agentId)
      .run();

    const backend = new FakeComputeBackend();
    // Not prepared, and the setup script itself exits non-zero. Every setup
    // command is base64-wrapped, so that substring is the script's own shape.
    // The setup script itself exits non-zero. Every setup command is
    // base64-wrapped, so that substring is the script's own shape. The gate
    // needs no entry: an empty fake box is unprepared by default.
    backend.scriptedExits.push({ match: "base64 -d | bash", exitCode: 3 });

    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));
      await runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
        const agent = instance as unknown as TestableAgent;
        await agent.__unsafe_ensureInitialized();
        setComputeHostTestOverrides(threadId, { buildBackend: async () => backend });
        try {
          const session = await agent.resolveComputeServiceForTest();
          await session!.service.ensureRuntimeReference();
        } finally {
          clearComputeHostTestOverrides(threadId);
        }
      });

      const logged = warn.mock.calls.filter(
        (call) => call[0] === "compute.repository_preparation_incomplete",
      );
      expect(
        logged,
        `expected the failed setup script to be logged; warns were ${JSON.stringify(
          warn.mock.calls.map((call) => call[0]),
        )}`,
      ).toHaveLength(1);
      expect(JSON.stringify(logged[0]?.[1])).toContain("environment setup failed");
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * A permanently failing setup command must not stall every turn forever.
   *
   * Withholding the record on failure is the right default — a repository that
   * silently never arrives is the worse outcome — but it means a broken
   * `pnpm install` is retried on the first tool call of EVERY turn, with a
   * 15-minute timeout and no backoff. The cap is per DO wake and in memory, so
   * it can delay a recovery but never prevent one; what it must do is stop the
   * stall and say why.
   */
  it("stops retrying a permanently failing preparation, and says so", async () => {
    const threadId = "thr_turn_prep_capped";
    const workspaceId = "ws_turn_prep_capped";
    const agentId = "agent_turn_prep_capped";
    await seedRegistryThread(env.REGISTRY_DB, {
      threadId,
      workspaceId,
      agentId,
      runtime: "think",
    });
    await seedComputeEnabledWorkspace(workspaceId);
    await env.REGISTRY_DB.prepare("UPDATE agents SET setup_script = ? WHERE id = ?")
      .bind("exit 7", agentId)
      .run();

    const backend = new FakeComputeBackend();
    // The setup script fails, every time. The gate needs no entry: the fake
    // defaults an unprepared box, and a failed run is never recorded anyway.
    backend.scriptedExits.push({ match: "base64 -d | bash", exitCode: 7 });

    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));
    const turn = async () =>
      runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
        const agent = instance as unknown as TestableAgent;
        await agent.__unsafe_ensureInitialized();
        setComputeHostTestOverrides(threadId, { buildBackend: async () => backend });
        try {
          const before = backend.startProcessCalls.length + backend.runCommandCalls.length;
          const session = await agent.resolveComputeServiceForTest();
          await session!.service.ensureRuntimeReference();
          return backend.startProcessCalls.length + backend.runCommandCalls.length - before;
        } finally {
          clearComputeHostTestOverrides(threadId);
        }
      });

    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      // Three attempts, each retrying the whole thing.
      expect(await turn()).toBeGreaterThan(0);
      expect(await turn()).toBeGreaterThan(0);
      expect(await turn()).toBeGreaterThan(0);
      // The fourth turn pays nothing.
      expect(await turn()).toBe(0);

      const counts = warn.mock.calls
        .filter((call) => call[0] === "compute.repository_preparation_incomplete")
        .map((call) => (call[1] as { consecutiveFailures?: number })?.consecutiveFailures);
      // The consecutive count is what makes this diagnosable rather than a
      // mystery stall, so it is asserted rather than assumed.
      expect(counts).toEqual([1, 2, 3]);
      expect(
        warn.mock.calls.filter((call) => call[0] === "compute.repository_preparation_suspended"),
      ).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * The cap must fire on a STUCK configuration, never on a run of unrelated
   * transient ones. Keying the count on the failure list is what separates
   * them: three different failures in a row are three first attempts, not a
   * reason to stop trying.
   */
  it("restarts the failure count when the failure itself changes", async () => {
    const threadId = "thr_turn_prep_varied";
    const workspaceId = "ws_turn_prep_varied";
    const agentId = "agent_turn_prep_varied";
    await seedRegistryThread(env.REGISTRY_DB, {
      threadId,
      workspaceId,
      agentId,
      runtime: "think",
    });
    await seedComputeEnabledWorkspace(workspaceId);
    await env.REGISTRY_DB.prepare("UPDATE agents SET setup_script = ? WHERE id = ?")
      .bind("exit 1", agentId)
      .run();

    const backend = new FakeComputeBackend();
    const failWith = (exitCode: number) => {
      backend.scriptedExits.length = 0;
      backend.scriptedExits.push({ match: "base64 -d | bash", exitCode });
    };

    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));
    const turn = async () =>
      runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
        const agent = instance as unknown as TestableAgent;
        await agent.__unsafe_ensureInitialized();
        setComputeHostTestOverrides(threadId, { buildBackend: async () => backend });
        try {
          const before = backend.startProcessCalls.length + backend.runCommandCalls.length;
          const session = await agent.resolveComputeServiceForTest();
          await session!.service.ensureRuntimeReference();
          return backend.startProcessCalls.length + backend.runCommandCalls.length - before;
        } finally {
          clearComputeHostTestOverrides(threadId);
        }
      });

    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      // Four turns, a DIFFERENT failure each time: every one is attempt 1, and
      // the fourth still runs. Under a count that ignored the failure it would
      // have been suspended.
      for (const exitCode of [4, 5, 6, 8]) {
        failWith(exitCode);
        expect(await turn(), `turn failing with ${exitCode} must still attempt`).toBeGreaterThan(0);
      }

      const counts = warn.mock.calls
        .filter((call) => call[0] === "compute.repository_preparation_incomplete")
        .map((call) => (call[1] as { consecutiveFailures?: number })?.consecutiveFailures);
      expect(counts).toEqual([1, 1, 1, 1]);
      expect(
        warn.mock.calls.filter((call) => call[0] === "compute.repository_preparation_suspended"),
      ).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * A SUSPENSION MUST NOT OUTLIVE THE CONFIGURATION THAT CAUSED IT.
   *
   * The cap returns before `prepare()`, so nothing inside preparation could
   * move it: a user who fixed a broken `setup_script` mid-wake got no attempt
   * at all until the DO was evicted, and the only log was the one-shot
   * `..._suspended` from three turns earlier — so a turn that silently did no
   * preparation looked exactly like a turn with nothing to prepare.
   *
   * Both halves are asserted: the skip is LOGGED while the configuration is
   * unchanged, and the very next turn after the configuration changes attempts
   * again.
   */
  it("invalidates the suspension when the agent's configuration changes, and logs the skip", async () => {
    const threadId = "thr_turn_prep_unstuck";
    const workspaceId = "ws_turn_prep_unstuck";
    const agentId = "agent_turn_prep_unstuck";
    await seedRegistryThread(env.REGISTRY_DB, {
      threadId,
      workspaceId,
      agentId,
      runtime: "think",
    });
    await seedComputeEnabledWorkspace(workspaceId);
    await env.REGISTRY_DB.prepare("UPDATE agents SET setup_script = ? WHERE id = ?")
      .bind("exit 7", agentId)
      .run();

    const backend = new FakeComputeBackend();
    backend.scriptedExits.push({ match: "base64 -d | bash", exitCode: 7 });

    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));
    const turn = async () =>
      runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
        const agent = instance as unknown as TestableAgent;
        await agent.__unsafe_ensureInitialized();
        setComputeHostTestOverrides(threadId, { buildBackend: async () => backend });
        try {
          const before = backend.startProcessCalls.length + backend.runCommandCalls.length;
          const session = await agent.resolveComputeServiceForTest();
          await session!.service.ensureRuntimeReference();
          return backend.startProcessCalls.length + backend.runCommandCalls.length - before;
        } finally {
          clearComputeHostTestOverrides(threadId);
        }
      });

    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect(await turn(), `attempt ${attempt + 1} must run`).toBeGreaterThan(0);
      }
      // Suspended, and the skip says so — not silence.
      expect(await turn()).toBe(0);
      const skips = warn.mock.calls.filter(
        (call) => call[0] === "compute.repository_preparation_skipped",
      );
      expect(
        skips,
        `expected the skip to be logged; warns were ${JSON.stringify(
          warn.mock.calls.map((call) => call[0]),
        )}`,
      ).toHaveLength(1);
      expect((skips[0]?.[1] as { consecutiveFailures?: number })?.consecutiveFailures).toBe(3);

      // The user fixes the setup script, in the SAME DO wake.
      await env.REGISTRY_DB.prepare("UPDATE agents SET setup_script = ? WHERE id = ?")
        .bind("echo fixed", agentId)
        .run();
      backend.scriptedExits.length = 0;
      expect(await turn(), "a fixed configuration must be attempted immediately").toBeGreaterThan(
        0,
      );
      // And it succeeded, so nothing new was suspended or reported incomplete.
      expect(
        warn.mock.calls.filter((call) => call[0] === "compute.repository_preparation_incomplete"),
      ).toHaveLength(3);
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * The count restarts on a CONFIGURATION change too, not only on a different
   * failure message.
   *
   * Two failures under the old configuration and one under the new one are one
   * attempt at the new one — but the failure text here is identical (`exit 7`
   * either way), so keying the count on the failure list alone would carry the
   * old attempts across and suspend the new configuration after a single try.
   * Nothing would fail; the user would simply get no preparation for the rest
   * of the wake.
   */
  it("restarts the failure count when the configuration changes under an identical failure", async () => {
    const threadId = "thr_turn_prep_recount";
    const workspaceId = "ws_turn_prep_recount";
    const agentId = "agent_turn_prep_recount";
    await seedRegistryThread(env.REGISTRY_DB, {
      threadId,
      workspaceId,
      agentId,
      runtime: "think",
    });
    await seedComputeEnabledWorkspace(workspaceId);
    await env.REGISTRY_DB.prepare("UPDATE agents SET setup_script = ? WHERE id = ?")
      .bind("exit 7", agentId)
      .run();

    const backend = new FakeComputeBackend();
    backend.scriptedExits.push({ match: "base64 -d | bash", exitCode: 7 });

    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));
    const turn = async () =>
      runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
        const agent = instance as unknown as TestableAgent;
        await agent.__unsafe_ensureInitialized();
        setComputeHostTestOverrides(threadId, { buildBackend: async () => backend });
        try {
          const session = await agent.resolveComputeServiceForTest();
          await session!.service.ensureRuntimeReference();
        } finally {
          clearComputeHostTestOverrides(threadId);
        }
      });

    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      await turn();
      await turn();
      // A configuration change that does NOT change the failure text.
      await env.REGISTRY_DB.prepare(
        "UPDATE agents SET sandbox_network_domain_allowlist = ? WHERE id = ?",
      )
        .bind("github.com", agentId)
        .run();
      await turn();

      const counts = warn.mock.calls
        .filter((call) => call[0] === "compute.repository_preparation_incomplete")
        .map((call) => (call[1] as { consecutiveFailures?: number })?.consecutiveFailures);
      expect(counts).toEqual([1, 2, 1]);
      expect(
        warn.mock.calls.filter((call) => call[0] === "compute.repository_preparation_suspended"),
      ).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * The ALARM must not clone.
   *
   * Its tick reaches `exec` through the workspace-cleanliness probe, on a
   * service whose preparation latch is fresh — so once preparation moved onto
   * the per-service path, a signature change since the last turn would start a
   * `git clone` and a setup script inside an alarm handler, for a box nobody is
   * using, on the very path deciding whether to RELEASE it.
   *
   * The directories are still created — only the repository work is withheld.
   *
   * P3 ANTI-VACUITY NOTE: this used to hook the alarm's cleanliness probe as
   * proof the alarm had reached the box. That probe is gone with the discard
   * inference, so the release itself is now the proof.
   */
  it("does not prepare repositories from the alarm's tick", async () => {
    const threadId = "thr_turn_alarm_no_prep";
    const workspaceId = "ws_turn_alarm_no_prep";
    const agentId = "agent_turn_alarm_no_prep";
    await seedRegistryThread(env.REGISTRY_DB, {
      threadId,
      workspaceId,
      agentId,
      runtime: "think",
    });
    await seedComputeEnabledWorkspace(workspaceId);
    await env.REGISTRY_DB.prepare(
      `INSERT INTO agent_repositories
        (id, agent_id, source, name, url, default_branch, checkout_path_name, created_at)
       VALUES (?, ?, 'url', 'nadi', 'https://example.test/nadi.git', 'main', 'nadi', ?)`,
    )
      .bind(`agr_${threadId}`, agentId, NOW)
      .run();

    const backend = new FakeComputeBackend();

    // Open a session first, so the box has an alarm record to replay. Its own
    // preparation is expected and is not what this asserts.
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));
    await runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
      const agent = instance as unknown as TestableAgent;
      await agent.__unsafe_ensureInitialized();
      setComputeHostTestOverrides(threadId, { buildBackend: async () => backend });
      try {
        const session = await agent.resolveComputeServiceForTest();
        await session!.service.ensureRuntimeReference();
      } finally {
        clearComputeHostTestOverrides(threadId);
      }
    });

    // The alarm must actually REACH an `exec` for this to test anything: the
    // cleanliness probe only runs once the box is past its idle timeout (the
    // seeded settings say 15 minutes), and that probe is the path preparation
    // would ride in on.
    const sandbox = env.AGENT_SANDBOX.get(env.AGENT_SANDBOX.idFromName(agentId));
    setComputeHostTestOverrides(threadId, {
      buildBackend: async () => backend,
      now: () => NOW + 30 * 60_000,
    });
    const before = backend.startProcessCalls.length + backend.runCommandCalls.length;
    const releasesBefore = backend.releaseCalls.length;
    try {
      await runInDurableObject(sandbox, async (instance) => {
        await (instance as unknown as { alarm(): Promise<void> }).alarm();
      });
    } finally {
      clearComputeHostTestOverrides(threadId);
    }

    const duringAlarm = [
      ...backend.startProcessCalls.map((call) => call.command),
      ...backend.runCommandCalls.map((call) => call.command),
    ].slice(before);
    // ANTI-VACUITY: the alarm really did reach the sandbox and run its idle
    // decision. Without this the assertions below hold for an alarm that did
    // nothing at all.
    expect(
      backend.releaseCalls.length,
      "the alarm must have reached the idle release",
    ).toBeGreaterThan(releasesBefore);
    // And it PRESERVED: an alarm-side discard would be a `deleteSprite` on the
    // agent's shared box.
    expect(backend.releaseCalls.at(-1)?.options.disposition).toBe("recoverable");
    // The gate probe itself must not run either — preparation is not ENTERED.
    // Matched on the gate's own shape rather than on the sentinel's name: the
    // probe script legitimately names the sentinel too, in the exclusion that
    // stops it counting as work.
    expect(
      duringAlarm.filter((command) => command.includes('test "$(cat')),
      `the alarm must not enter preparation; commands were ${JSON.stringify(duringAlarm)}`,
    ).toEqual([]);
    expect(duringAlarm.filter((command) => command.includes("git clone"))).toEqual([]);
    expect(duringAlarm.filter((command) => command.includes("mkdir -p /workspace/repos"))).toEqual(
      [],
    );
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
