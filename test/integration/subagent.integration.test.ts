import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";
import type { SubAgent } from "../../src/agent/subagent";
import { SUBAGENT_DEADLINE_MS, SUBAGENT_STALE_AFTER_MS } from "../../src/agent/work-ledger";

// TEST-ONLY: `SUB_AGENT` is a test-only Miniflare binding (see vitest.config.ts)
// for a facet-only class with no wrangler.jsonc binding, so it's not present in
// the generated worker-configuration.d.ts. Augment `Cloudflare.Env` here so the
// binding is typed for this test file without touching the generated types.
declare global {
  namespace Cloudflare {
    interface Env {
      SUB_AGENT: DurableObjectNamespace<SubAgent>;
    }
  }
}

beforeAll(async () => {
  await applyRegistryTestSchema(env.REGISTRY_DB);
  await seedRegistryThread(env.REGISTRY_DB, {
    workspaceId: "ws-sub-parent",
    agentId: "agent-sub-parent",
    threadId: "sub-parent",
    runtime: "think",
    provider: "mock",
    model: "mock",
  });
});

type SubAgentTestSeam = SubAgent & {
  _testSubagentContext?: {
    parentThreadId: string;
    workspaceId: string;
    agentId: string;
    attachedRuntime: { provider: string; version: 1; payload: Record<string, string> };
  };
  __unsafe_ensureInitialized(): Promise<void>;
};

// `runInDurableObject`'s generic inference blows up ("Type instantiation is
// excessively deep") against Think's deeply generic Session/TurnConfig types —
// see the same workaround in think-thread-agent.integration.test.ts.
const runInSubAgentDo = runInDurableObject as any;

/** Register an open subagent lease the way `spawnSubagent` does — the lease set
 *  is now DERIVED from these rows, so this is what "a live child" looks like. */
function registerSubagentRow(parent: any, runId: string): void {
  const now = Date.now();
  parent.workLedger.register({
    id: runId,
    kind: "subagent",
    startedAt: now,
    lastAliveAt: now,
    staleAfterMs: SUBAGENT_STALE_AFTER_MS,
    deadlineAt: now + SUBAGENT_DEADLINE_MS,
    generation: "gen-test",
    terminal: null,
  });
}

describe("SubAgent", () => {
  it("inherits the parent's identity and cannot spawn subagents", async () => {
    const stub = env.SUB_AGENT.get(env.SUB_AGENT.idFromName("sub_run_1"));
    const result = await runInSubAgentDo(stub, async (child: SubAgentTestSeam) => {
      child._testSubagentContext = {
        parentThreadId: "sub-parent",
        workspaceId: "ws-sub-parent",
        agentId: "agent-sub-parent",
        attachedRuntime: {
          provider: "daytona",
          version: 1,
          payload: { kind: "runtime", sandboxId: "fake_sbx_parent" },
        },
      };
      await child.__unsafe_ensureInitialized();
      const probe = await child.providerProbeForTest();
      await child.runTurn({ input: "hello" });
      return { probe, tools: child.beforeTurnToolNamesForTest() };
    });

    // Identity is the PARENT's, from the injected context (not the facet name):
    expect(result.probe.workspaceId).toBe("ws-sub-parent");
    expect(result.probe.agentId).toBe("agent-sub-parent");
    // Depth-1: the subagent never gets the spawn tool.
    expect(result.tools).not.toContain("spawn_subagent");
  });

  it("releases the child lease on onAgentToolFinish", async () => {
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName("sub-parent"));
    // `runInDurableObject`'s generic inference blows up against Think's deeply
    // generic Session/TurnConfig types (same issue as `runInSubAgentDo` above),
    // so this call is untyped like the others in think-thread-agent.integration.test.ts.
    const { remaining, row } = await (runInDurableObject as any)(stub, async (parent: any) => {
      await parent.__unsafe_ensureInitialized?.();
      registerSubagentRow(parent, "sub_done");
      await parent.onAgentToolFinish(
        {
          runId: "sub_done",
          agentType: "SubAgent",
          status: "completed",
          displayOrder: 0,
          startedAt: 0,
        },
        { status: "completed" },
      );
      return { remaining: parent.openSubagentRunIds(), row: parent.workLedger.get("sub_done") };
    });
    expect(remaining).not.toContain("sub_done");
    // The lease is the ROW: releasing it means closing it, not deleting it —
    // the closed row is still what `finishedAt` derives from.
    expect(row.terminal.outcome).toBe("exited");
  });

  it("keeps the lease across a soft interrupt while the child is still running, releases it on the real completion", async () => {
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName("sub-parent"));
    // `runInDurableObject`'s generic inference blows up against Think's deeply
    // generic Session/TurnConfig types (same issue as `runInSubAgentDo` above),
    // so this call is untyped like the others in think-thread-agent.integration.test.ts.
    const { afterInterrupt, afterCompletion } = await (runInDurableObject as any)(
      stub,
      async (parent: any) => {
        await parent.__unsafe_ensureInitialized?.();
        registerSubagentRow(parent, "sub_live");

        // Soft interrupt: the parent stopped waiting, but the child facet is
        // STILL RUNNING on the shared machine. The lease must NOT be released.
        await parent.onAgentToolFinish(
          {
            runId: "sub_live",
            agentType: "SubAgent",
            status: "interrupted",
            childStillRunning: true,
            displayOrder: 0,
            startedAt: 0,
          },
          { status: "interrupted", childStillRunning: true },
        );
        const afterInterrupt = parent.openSubagentRunIds();

        // Real terminal: the child actually finished. The lease is released now.
        await parent.onAgentToolFinish(
          {
            runId: "sub_live",
            agentType: "SubAgent",
            status: "completed",
            displayOrder: 0,
            startedAt: 0,
          },
          { status: "completed" },
        );
        const afterCompletion = parent.openSubagentRunIds();

        return { afterInterrupt, afterCompletion };
      },
    );
    expect(afterInterrupt).toContain("sub_live");
    expect(afterCompletion).not.toContain("sub_live");
  });

  it("a cancelled run is reported as stopped, never as exited", async () => {
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName("sub-parent"));
    const row = await (runInDurableObject as any)(stub, async (parent: any) => {
      await parent.__unsafe_ensureInitialized?.();
      registerSubagentRow(parent, "sub_cancelled");
      await parent.onAgentToolFinish(
        {
          runId: "sub_cancelled",
          agentType: "SubAgent",
          status: "aborted",
          displayOrder: 0,
          startedAt: 0,
        },
        { status: "aborted" },
      );
      return parent.workLedger.get("sub_cancelled");
    });
    expect(row.terminal.outcome).toBe("stopped");
    expect(row.terminal.reason).toBe("process_stopped");
  });

  it("passes a human display label to the dispatched run (label preferred, task fallback)", async () => {
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName("sub-parent"));
    const captured = await (runInDurableObject as any)(stub, async (parent: any) => {
      await parent.__unsafe_ensureInitialized?.();
      // Avoid real provisioning + real facet dispatch: stub the two collaborators
      // spawnSubagent calls, capturing the options handed to runAgentTool.
      parent.getSubagentContext = async () => ({
        parentThreadId: "sub-parent",
        workspaceId: "ws-sub-parent",
        agentId: "agent-sub-parent",
        attachedRuntime: {
          provider: "daytona",
          version: 1,
          payload: { kind: "runtime", sandboxId: "fake_sbx_parent" },
        },
      });
      const seen: any[] = [];
      parent.runAgentTool = async (_cls: unknown, opts: any) => {
        seen.push(opts);
        return { runId: opts.runId, agentType: "SubAgent", status: "running" };
      };
      await parent.spawnSubagent({
        task: "scan the repo",
        label: "Repo scan",
        toolCallId: "tc_abc",
      });
      await parent.spawnSubagent({ task: "just a task, no label" });
      return seen.map((o) => ({ display: o.display, parentToolCallId: o.parentToolCallId }));
    });
    expect(captured[0]).toEqual({ display: { name: "Repo scan" }, parentToolCallId: "tc_abc" });
    // No toolCallId supplied → parentToolCallId is omitted (undefined), so the
    // dispatch stays valid rather than binding to a bogus id.
    expect(captured[1]).toEqual({
      display: { name: "just a task, no label" },
      parentToolCallId: undefined,
    });
  });

  it("emits a 'working' progress signal at turn start", async () => {
    const stub = env.SUB_AGENT.get(env.SUB_AGENT.idFromName("sub_run_progress"));
    const calls = await runInSubAgentDo(stub, async (child: SubAgentTestSeam) => {
      child._testSubagentContext = {
        parentThreadId: "sub-parent",
        workspaceId: "ws-sub-parent",
        agentId: "agent-sub-parent",
        attachedRuntime: {
          provider: "daytona",
          version: 1,
          payload: { kind: "runtime", sandboxId: "fake_sbx_parent" },
        },
      };
      await child.__unsafe_ensureInitialized();
      const seen: unknown[] = [];
      // Spy: reportProgress is a real method; capture what beforeTurn emits.
      (child as any).reportProgress = async (p: unknown) => {
        seen.push(p);
      };
      await child.runTurn({ input: "hello" });
      return seen;
    });
    // U3: beforeTurn now emits a per-turn progress signal with a step message,
    // so match the phase without pinning the exact message text.
    expect(calls).toContainEqual(expect.objectContaining({ phase: "working" }));
  });

  /**
   * The seam that shipped broken: `reportProgress` persists to THIS facet's own
   * storage, so the dock (which reads the PARENT's ledger) saw nothing and sat
   * on "Waiting for the first update" forever. The child must therefore PUSH its
   * progress to the parent, and it does so on the liveness stamp.
   *
   * Asserted on the parent-facing call, not on `reportProgress`: the test above
   * already covers the SDK call, and it passing is exactly what made the gap
   * invisible.
   */
  it("pushes its progress to the parent on the liveness stamp, not only to the SDK", async () => {
    const stub = env.SUB_AGENT.get(env.SUB_AGENT.idFromName("sub_run_progress_push"));
    const stamps = await runInSubAgentDo(stub, async (child: SubAgentTestSeam) => {
      child._testSubagentContext = {
        parentThreadId: "sub-parent",
        workspaceId: "ws-sub-parent",
        agentId: "agent-sub-parent",
        attachedRuntime: {
          provider: "daytona",
          version: 1,
          payload: { kind: "runtime", sandboxId: "fake_sbx_parent" },
        },
      };
      await child.__unsafe_ensureInitialized();
      const seen: Array<[string, unknown]> = [];
      (child as any).reportProgress = async () => {};
      (child as any).parentAgent = async () => ({
        stampSubagentAlive: async (runId: string, progress: unknown) => {
          seen.push([runId, progress]);
        },
      });
      await child.runTurn({ input: "hello" });
      return seen;
    });
    // Asserted on the FIRST stamp of the turn, which is the user-visible
    // property: no blank window before the dock shows a step. (Reordering the
    // marker after `startLiveness` does NOT break this today — the stamp reads
    // the field only after awaiting `parentAgent()` — so this pins the
    // guarantee, not that ordering.)
    expect(stamps.length).toBeGreaterThan(0);
    expect(stamps[0]![1]).toMatchObject({ phase: "working" });
    expect(stamps[0]![1]).toHaveProperty("at", expect.any(Number));
  });

  /**
   * The number the dock shows counts TOOL CALLS, cumulatively across the run's
   * steps. It used to count turns — and a subagent runs exactly one turn, so it
   * read "step 1" for the entire run and only moved when the turn was re-entered
   * after a recovery, i.e. it counted restarts while looking like progress.
   *
   * Driven through the real `onStepFinish` with synthetic step records, because
   * the point is the accumulation across steps, not one step's shape.
   */
  it("counts tool calls across steps, not turns", async () => {
    const stub = env.SUB_AGENT.get(env.SUB_AGENT.idFromName("sub_run_toolcalls"));
    const seen = await runInSubAgentDo(stub, async (child: SubAgentTestSeam) => {
      child._testSubagentContext = {
        parentThreadId: "sub-parent",
        workspaceId: "ws-sub-parent",
        agentId: "agent-sub-parent",
        attachedRuntime: {
          provider: "daytona",
          version: 1,
          payload: { kind: "runtime", sandboxId: "fake_sbx_parent" },
        },
      };
      await child.__unsafe_ensureInitialized();
      (child as any).reportProgress = async () => {};
      (child as any).parentAgent = async () => ({ stampSubagentAlive: async () => {} });
      const step = (calls: number) => ({ toolCalls: Array.from({ length: calls }, () => ({})) });
      const messages: Array<string | undefined> = [];
      const read = () => (child as any)._progress?.message as string | undefined;

      (child as any).onStepFinish(step(1));
      messages.push(read());
      (child as any).onStepFinish(step(2));
      messages.push(read());
      // A closing text step makes no tool calls — the count must hold, not tick.
      (child as any).onStepFinish(step(0));
      messages.push(read());
      return messages;
    });
    expect(seen[0]).toBe("1 tool call"); // singular
    expect(seen[1]).toBe("3 tool calls"); // cumulative, not per-step
    expect(seen[2]).toBe("3 tool calls"); // unchanged by a tool-less step
  });

  it("rate-limits the per-step push, and never blocks the tool loop on it", async () => {
    const stub = env.SUB_AGENT.get(env.SUB_AGENT.idFromName("sub_run_push_throttle"));
    const result = await runInSubAgentDo(stub, async (child: SubAgentTestSeam) => {
      child._testSubagentContext = {
        parentThreadId: "sub-parent",
        workspaceId: "ws-sub-parent",
        agentId: "agent-sub-parent",
        attachedRuntime: {
          provider: "daytona",
          version: 1,
          payload: { kind: "runtime", sandboxId: "fake_sbx_parent" },
        },
      };
      await child.__unsafe_ensureInitialized();
      (child as any).reportProgress = async () => {};
      let pushes = 0;
      (child as any).parentAgent = async () => ({
        stampSubagentAlive: async () => {
          pushes += 1;
        },
      });
      const step = () => ({ toolCalls: [{}] });
      // Four steps back to back, well inside the 5s floor.
      for (let i = 0; i < 4; i += 1) (child as any).onStepFinish(step());
      // The count itself is NOT throttled — only its publication is.
      const message = (child as any)._progress?.message as string | undefined;
      // Let the fire-and-forget push settle before counting it.
      await scheduler.wait(0);
      return { pushes, message };
    });
    expect(result.message).toBe("4 tool calls");
    expect(result.pushes).toBe(1);
  });

  it("disables process monitoring (closes H1/H2): SubAgent overrides processMonitorEnabled to false", async () => {
    const stub = env.SUB_AGENT.get(env.SUB_AGENT.idFromName("sub_run_monitor"));
    const enabled = await runInSubAgentDo(stub, async (child: SubAgentTestSeam) => {
      child._testSubagentContext = {
        parentThreadId: "sub-parent",
        workspaceId: "ws-sub-parent",
        agentId: "agent-sub-parent",
        attachedRuntime: {
          provider: "daytona",
          version: 1,
          payload: { kind: "runtime", sandboxId: "fake_sbx_parent" },
        },
      };
      await child.__unsafe_ensureInitialized();
      return (child as any).processMonitorEnabledForTest();
    });
    expect(enabled).toBe(false);
  });

  it("injects a subagent-role system context (top-level thread does not)", async () => {
    const subStub = env.SUB_AGENT.get(env.SUB_AGENT.idFromName("sub_run_role"));
    const role = await runInSubAgentDo(subStub, async (child: SubAgentTestSeam) => {
      return (
        child as unknown as { sessionRoleContextForTest(): unknown }
      ).sessionRoleContextForTest();
    });
    expect(role).toMatchObject({ name: "subagent-role" });
    const text = (role as { text: string }).text;
    expect(text).toMatch(/subagent/i);
    expect(text).toMatch(/Use exec/);
    expect(text).not.toMatch(/exec_watch/);
    expect(text).not.toMatch(/exec_start/);
    expect(text).toMatch(/exec is synchronous/);
    expect(text).toMatch(/waits until the command exits/);
    expect(text).toMatch(/cannot manually watch or start background processes/);

    const parentStub = env.THINK_THREAD_AGENT.get(
      env.THINK_THREAD_AGENT.idFromName("thr_role_null"),
    );
    const parentRole = await (runInDurableObject as any)(
      parentStub,
      async (parent: { sessionRoleContextForTest(): unknown }) =>
        parent.sessionRoleContextForTest(),
    );
    expect(parentRole).toBeNull();
  });

  it("cancelSubagentRun delegates to cancelAgentTool, idempotently", async () => {
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName("sub-parent"));
    const out = await (runInDurableObject as any)(stub, async (parent: any) => {
      await parent.__unsafe_ensureInitialized?.();
      const cancelled: string[] = [];
      parent.cancelAgentTool = async (id: string) => {
        cancelled.push(id);
      };
      await parent.cancelSubagentRun("sub_x");
      await parent.cancelSubagentRun("sub_unknown"); // idempotent: must not throw
      return { cancelled };
    });
    expect(out.cancelled).toEqual(["sub_x", "sub_unknown"]);
  });

  /**
   * DATA LOSS GUARD. The parent's `sandbox:declared-clean` bit is what lets
   * `resolveIdleDisposition` short-circuit straight to `discard` without
   * probing. An attached subagent writes to the PARENT's machine, so a write
   * here has to invalidate the PARENT's bit — if it only cleared the facet's
   * own storage (which nothing reads), the parent would destroy the
   * subagent's uncommitted work at the next idle release.
   *
   * This drives the REAL `sandboxHostDeps().markSandboxDirty` closure — the
   * same one `ThreadComputeService.execRun`/`execStart` awaits before every
   * command — not a reconstruction of it.
   */
  it("an attached subagent's write clears the PARENT's declared-clean bit", async () => {
    const parentStub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName("sub-parent"));
    await (runInDurableObject as any)(parentStub, async (parent: any) => {
      await parent.__unsafe_ensureInitialized?.();
      await parent.setSandboxDeclaredClean(true);
    });
    // Pre-condition: the parent really did hold a clean bit.
    const before = await (runInDurableObject as any)(parentStub, (parent: any) =>
      parent.getSandboxDeclaredClean(),
    );
    expect(before).toBe(true);

    const childStub = env.SUB_AGENT.get(env.SUB_AGENT.idFromName("sub_run_dirty"));
    await runInSubAgentDo(childStub, async (child: SubAgentTestSeam) => {
      child._testSubagentContext = {
        parentThreadId: "sub-parent",
        workspaceId: "ws-sub-parent",
        agentId: "agent-sub-parent",
        attachedRuntime: {
          provider: "daytona",
          version: 1,
          payload: { kind: "runtime", sandboxId: "fake_sbx_parent" },
        },
      };
      await child.__unsafe_ensureInitialized();
      // Cache the attached runtime the way beforeTurn does, so
      // attachedRuntimeForThisAgent() reads it synchronously.
      await (child as any).primeAttachedContext();
      await (child as any).sandboxHostDeps().markSandboxDirty();
    });

    const after = await (runInDurableObject as any)(parentStub, (parent: any) =>
      parent.getSandboxDeclaredClean(),
    );
    expect(after).toBe(false);
  });
});
