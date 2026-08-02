import { describe, expect, it, vi } from "vitest";
import { confirmWorkSaved } from "../../../src/agent/work-saved-tool";
import { buildComputeToolDefs } from "../../../src/agent/compute-tools";
import { log } from "../../../src/log";

const setDeclaredClean = () => vi.fn().mockResolvedValue(undefined);

const getService = vi.fn(async () => ({}) as never);
const getFileContext = vi.fn(async () => ({
  env: {} as never,
  threadId: "thr_1",
  workspaceId: "ws_1",
}));

describe("confirmWorkSaved", () => {
  it("sets the bit when every repo is clean", async () => {
    const set = setDeclaredClean();
    const message = await confirmWorkSaved({
      probe: async () => ({ state: "clean" }),
      setDeclaredClean: set,
    });
    expect(set).toHaveBeenCalledWith(true);
    expect(message).toMatch(/discard/i);
  });

  it("refuses and does NOT set the bit when a repo is dirty", async () => {
    const set = setDeclaredClean();
    const message = await confirmWorkSaved({
      probe: async () => ({
        state: "dirty",
        repos: [{ path: "/workspace/app", changes: [" M src/a.ts"], unpushed: 0 }],
      }),
      setDeclaredClean: set,
    });
    expect(set).not.toHaveBeenCalled();
    expect(message).toContain("/workspace/app");
    expect(message).toContain("src/a.ts");
  });

  it("logs the refusal with a dirty-repo COUNT, never the repo path", async () => {
    // The refusal message to the MODEL is allowed to carry paths (it's
    // caller-scoped and actionable); the LOG must not — paths can carry
    // sensitive project names. Assert `reason` exactly: it's the only
    // after-the-fact record of why a declaration was refused.
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => {});
    const set = setDeclaredClean();
    await confirmWorkSaved({
      threadId: "thr_1",
      probe: async () => ({
        state: "dirty",
        repos: [
          { path: "/workspace/secret-project", changes: [" M x"], unpushed: 0 },
          { path: "/workspace/other", changes: [], unpushed: 2 },
        ],
      }),
      setDeclaredClean: set,
    });
    expect(infoSpy).toHaveBeenCalledWith("compute.work_saved_refused", {
      threadId: "thr_1",
      reason: "dirty",
      dirtyRepoCount: 2,
    });
    const call = infoSpy.mock.calls.find(([event]) => event === "compute.work_saved_refused");
    expect(JSON.stringify(call)).not.toContain("secret-project");
    infoSpy.mockRestore();
  });

  it("reads naturally for a repo that is clean except for unpushed commits", async () => {
    const set = setDeclaredClean();
    const message = await confirmWorkSaved({
      probe: async () => ({
        state: "dirty",
        repos: [{ path: "/workspace/app", changes: [], unpushed: 2 }],
      }),
      setDeclaredClean: set,
    });
    expect(set).not.toHaveBeenCalled();
    expect(message).toContain("/workspace/app: working tree clean; 2 unpushed commit(s)");
    expect(message).not.toContain("no local changes");
  });

  it("refuses when files exist with no version control", async () => {
    const set = setDeclaredClean();
    const message = await confirmWorkSaved({
      probe: async () => ({ state: "no_repo", hasFiles: true }),
      setDeclaredClean: set,
    });
    expect(set).not.toHaveBeenCalled();
    expect(message).toMatch(/not under version control/i);
  });

  it("accepts an empty workspace with no repo", async () => {
    const set = setDeclaredClean();
    await confirmWorkSaved({
      probe: async () => ({ state: "no_repo", hasFiles: false }),
      setDeclaredClean: set,
    });
    expect(set).toHaveBeenCalledWith(true);
  });

  it("is not registered for an attached subagent", async () => {
    // A subagent shares the parent's runtime; letting it declare the parent's
    // sandbox discardable would destroy the parent's work.
    const tools = buildComputeToolDefs(getService, getFileContext, {
      attachedRuntime: { provider: "daytona", version: 1, payload: { id: "sbx_parent" } },
      workSaved: { probe: async () => ({ state: "clean" }), setDeclaredClean: async () => {} },
    });
    expect(tools).not.toHaveProperty("confirm_work_saved");
  });

  it("refuses when the probe fails, leaving the sandbox preserved", async () => {
    const set = setDeclaredClean();
    const message = await confirmWorkSaved({
      probe: async () => ({ state: "probe_failed", reason: "runtime unreachable" }),
      setDeclaredClean: set,
    });
    expect(set).not.toHaveBeenCalled();
    expect(message).toMatch(/could not/i);
  });
});
