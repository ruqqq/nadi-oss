import { describe, expect, it, vi } from "vitest";

/**
 * Drives the REAL `confirm_workbench_switch` tool `execute()` built by
 * `buildComputeToolDefs`, not the pure `commitWorkbenchSwitchIfPending`
 * function (see `workbench-switch-commit.test.ts`) and not the turn-end
 * backstop (see `workbench-switch-commit-wiring.test.ts`). This is the tool
 * path: the save-your-work reminder tells the model to call this tool
 * directly, so a regression where the tool stops calling
 * `commitWorkbenchSwitchIfPending` — or wires the wrong deps — would pass
 * every other test in the suite.
 */
describe("confirm_workbench_switch tool execute()", () => {
  it("commits the pending switch and tears down the sandbox", async () => {
    vi.resetModules();
    const commitWorkbenchSwitch = vi.fn().mockResolvedValue(true);
    vi.doMock("../../../src/db/repositories/threads", () => ({
      ThreadRepository: class {
        commitWorkbenchSwitch = commitWorkbenchSwitch;
      },
    }));
    vi.doMock("../../../src/db/client", () => ({
      registryDb: (env: unknown) => env,
    }));
    const { buildComputeToolDefs } = await import("../../../src/agent/compute-tools");

    const execShutdown = vi.fn().mockResolvedValue({ ok: true, terminated: true });
    const getService = vi.fn(async () => ({ execShutdown }) as never);
    const getFileContext = vi.fn(async () => ({
      env: {} as never,
      threadId: "thr_1",
      workspaceId: "ws_1",
    }));
    const hasBlockingWork = vi.fn().mockResolvedValue(false);
    const adoptCommittedResourceProfile = vi.fn().mockResolvedValue(undefined);

    const tools = buildComputeToolDefs(getService, getFileContext, {
      workbenchSwitch: { hasBlockingWork, adoptCommittedResourceProfile },
      now: () => 1_000,
    });

    const result = await (
      tools.confirm_workbench_switch as { execute: (input: object) => Promise<unknown> }
    ).execute({});

    expect(commitWorkbenchSwitch).toHaveBeenCalledWith("thr_1", 1_000);
    expect(execShutdown).toHaveBeenCalledWith({ confirm: true });
    expect(result).toEqual({ committed: true });
  });

  it("does not commit or tear down when hasBlockingWork resolves true", async () => {
    vi.resetModules();
    const commitWorkbenchSwitch = vi.fn().mockResolvedValue(true);
    vi.doMock("../../../src/db/repositories/threads", () => ({
      ThreadRepository: class {
        commitWorkbenchSwitch = commitWorkbenchSwitch;
      },
    }));
    vi.doMock("../../../src/db/client", () => ({
      registryDb: (env: unknown) => env,
    }));
    const { buildComputeToolDefs } = await import("../../../src/agent/compute-tools");

    const execShutdown = vi.fn().mockResolvedValue({ ok: true, terminated: true });
    const getService = vi.fn(async () => ({ execShutdown }) as never);
    const getFileContext = vi.fn(async () => ({
      env: {} as never,
      threadId: "thr_1",
      workspaceId: "ws_1",
    }));
    const hasBlockingWork = vi.fn().mockResolvedValue(true);
    const adoptCommittedResourceProfile = vi.fn().mockResolvedValue(undefined);

    const tools = buildComputeToolDefs(getService, getFileContext, {
      workbenchSwitch: { hasBlockingWork, adoptCommittedResourceProfile },
      now: () => 1_000,
    });

    const result = await (
      tools.confirm_workbench_switch as { execute: (input: object) => Promise<unknown> }
    ).execute({});

    expect(commitWorkbenchSwitch).not.toHaveBeenCalled();
    expect(execShutdown).not.toHaveBeenCalled();
    expect(result).toEqual({ committed: false });
  });

  // The precondition used to default to `async () => false`, which fails OPEN:
  // the commit lands, THEN execShutdown throws `compute_children_active`, and
  // that throw is swallowed — new snapshot, old sandbox, live subagents.
  // Withholding the tool entirely makes that state unreachable.
  it("is not registered at all when its safety preconditions are not wired", async () => {
    vi.resetModules();
    const { buildComputeToolDefs } = await import("../../../src/agent/compute-tools");

    const tools = buildComputeToolDefs(
      vi.fn(async () => ({}) as never),
      vi.fn(async () => ({ env: {} as never, threadId: "thr_1", workspaceId: "ws_1" })),
      { now: () => 1_000 },
    );

    expect(tools.confirm_workbench_switch).toBeUndefined();
    // Sanity: the rest of the compute surface is unaffected.
    expect(tools.exec).toBeDefined();
  });
});
