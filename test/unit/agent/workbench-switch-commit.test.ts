import { describe, expect, it, vi } from "vitest";
import { commitWorkbenchSwitchIfPending } from "../../../src/agent/workbench-switch-commit";

function deps(overrides = {}) {
  return {
    threadId: "thr_1",
    now: () => 500,
    commitWorkbenchSwitch: vi.fn().mockResolvedValue(true),
    execShutdown: vi.fn().mockResolvedValue({ ok: true, terminated: true }),
    hasBlockingWork: vi.fn().mockResolvedValue(false),
    adoptCommittedResourceProfile: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("commitWorkbenchSwitchIfPending", () => {
  it("tears the sandbox down when it wins the permit", async () => {
    const d = deps();
    const result = await commitWorkbenchSwitchIfPending(d);
    expect(result.committed).toBe(true);
    expect(d.execShutdown).toHaveBeenCalledOnce();
  });

  it("defers while subagents are still running, leaving the switch retryable", async () => {
    const d = deps({ hasBlockingWork: vi.fn().mockResolvedValue(true) });
    const result = await commitWorkbenchSwitchIfPending(d);
    expect(result.committed).toBe(false);
    expect(d.commitWorkbenchSwitch).not.toHaveBeenCalled();
    expect(d.execShutdown).not.toHaveBeenCalled();
  });

  it("does nothing when another caller already committed", async () => {
    const d = deps({ commitWorkbenchSwitch: vi.fn().mockResolvedValue(false) });
    const result = await commitWorkbenchSwitchIfPending(d);
    expect(result.committed).toBe(false);
    expect(d.execShutdown).not.toHaveBeenCalled();
  });

  it("still reports committed when teardown fails, so the thread is not wedged", async () => {
    const d = deps({ execShutdown: vi.fn().mockRejectedValue(new Error("gone")) });
    const result = await commitWorkbenchSwitchIfPending(d);
    expect(result.committed).toBe(true);
  });

  // The DO-persisted profile wins over the workbench-derived config on every
  // read, so a switch that does not rewrite it leaves the thread provisioning
  // the OLD workbench's size and base image forever.
  it("rewrites the stored resource profile, before tearing the sandbox down", async () => {
    const order: string[] = [];
    const d = deps({
      adoptCommittedResourceProfile: vi.fn().mockImplementation(async () => {
        order.push("adopt");
      }),
      execShutdown: vi.fn().mockImplementation(async () => {
        order.push("shutdown");
      }),
    });
    await commitWorkbenchSwitchIfPending(d);
    expect(d.adoptCommittedResourceProfile).toHaveBeenCalledOnce();
    expect(order).toEqual(["adopt", "shutdown"]);
  });

  // Teardown failure is swallowed by design; the profile rewrite must already
  // have happened or the stale value survives the very case that needs it most.
  it("rewrites the stored resource profile even when teardown fails", async () => {
    const d = deps({ execShutdown: vi.fn().mockRejectedValue(new Error("gone")) });
    await commitWorkbenchSwitchIfPending(d);
    expect(d.adoptCommittedResourceProfile).toHaveBeenCalledOnce();
  });

  it("leaves the stored profile alone when it lost the commit permit", async () => {
    const d = deps({ commitWorkbenchSwitch: vi.fn().mockResolvedValue(false) });
    await commitWorkbenchSwitchIfPending(d);
    expect(d.adoptCommittedResourceProfile).not.toHaveBeenCalled();
  });

  it("leaves the stored profile alone while subagents block the commit", async () => {
    const d = deps({ hasBlockingWork: vi.fn().mockResolvedValue(true) });
    await commitWorkbenchSwitchIfPending(d);
    expect(d.adoptCommittedResourceProfile).not.toHaveBeenCalled();
  });
});
