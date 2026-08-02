import { describe, expect, it, vi } from "vitest";
import { ThinkThreadAgent } from "../../../src/agent/think-thread-agent";
import { TurnUsageAccumulator } from "../../../src/agent/usage-recorder";

/**
 * WIRING, not the pure commit function. `workbench-switch-commit.test.ts`
 * proves `commitWorkbenchSwitchIfPending` itself; nothing there would notice
 * if the turn-end backstop call site in `onChatResponse` were deleted. This
 * calls the REAL `onChatResponse` (no DO, no env, no Think — same seam as
 * `turn-usage-wiring.test.ts`) and proves it is what invokes
 * `workbenchSwitchCommitDeps()` and threads the result into the real
 * `commitWorkbenchSwitchIfPending`.
 */

/** The protected/private turn-end hook, reached without constructing a DO. */
function agent(): Record<string, unknown> {
  const a = Object.create(ThinkThreadAgent.prototype) as Record<string, unknown>;
  a.turnUsage = new TurnUsageAccumulator();
  a.tracksContextGauge = false;
  a._usageFlush = null;
  a._currentContextWindow = 200_000;
  a._currentCompactAfterTokens = 118_400;
  a._turnRuntimeConfig = {
    workspaceId: "ws_1",
    agentId: "agent_1",
    modelConfig: { provider: "anthropic", model: "claude-sonnet-5" },
  };
  a.env = {};
  Object.defineProperty(a, "name", { value: "thr_1", configurable: true });
  // The rest of the turn-end hook needs a DO; stub only what it reaches
  // before and after the workbench-switch block under test.
  a.processMonitorEnabled = () => false;
  a.injectionBuffer = () => ({ isEmpty: () => true });
  a.turnHasPendingApproval = async () => false;
  a.resolveRuntimeConfigForThink = async () => {
    throw new Error("no registry in the unit env");
  };
  return a;
}

describe("onChatResponse workbench-switch commit backstop", () => {
  it("calls workbenchSwitchCommitDeps() and tears down through the real commit path", async () => {
    const a = agent();
    const execShutdown = vi.fn().mockResolvedValue({ ok: true, terminated: true });
    const commitWorkbenchSwitch = vi.fn().mockResolvedValue(true);
    const hasBlockingWork = vi.fn().mockResolvedValue(false);
    const adoptCommittedResourceProfile = vi.fn().mockResolvedValue(undefined);
    const workbenchSwitchCommitDeps = vi.fn(() => ({
      threadId: "thr_1",
      now: () => 1_000,
      commitWorkbenchSwitch,
      execShutdown,
      hasBlockingWork,
      adoptCommittedResourceProfile,
    }));
    a.workbenchSwitchCommitDeps = workbenchSwitchCommitDeps;

    await (ThinkThreadAgent.prototype.onChatResponse as () => Promise<void>).call(a);

    expect(workbenchSwitchCommitDeps).toHaveBeenCalledOnce();
    expect(hasBlockingWork).toHaveBeenCalledOnce();
    expect(commitWorkbenchSwitch).toHaveBeenCalledWith("thr_1", 1_000);
    // The DO-persisted profile must be re-adopted, or the stale value shadows
    // the newly-committed workbench's profile on the next acquisition.
    expect(adoptCommittedResourceProfile).toHaveBeenCalledOnce();
    expect(execShutdown).toHaveBeenCalledOnce();
  });

  it("defers when blocking work is present, without touching the sandbox", async () => {
    const a = agent();
    const execShutdown = vi.fn().mockResolvedValue({ ok: true, terminated: true });
    const commitWorkbenchSwitch = vi.fn().mockResolvedValue(true);
    const hasBlockingWork = vi.fn().mockResolvedValue(true);
    a.workbenchSwitchCommitDeps = () => ({
      threadId: "thr_1",
      now: () => 1_000,
      commitWorkbenchSwitch,
      execShutdown,
      hasBlockingWork,
    });

    await (ThinkThreadAgent.prototype.onChatResponse as () => Promise<void>).call(a);

    expect(commitWorkbenchSwitch).not.toHaveBeenCalled();
    expect(execShutdown).not.toHaveBeenCalled();
  });
});
