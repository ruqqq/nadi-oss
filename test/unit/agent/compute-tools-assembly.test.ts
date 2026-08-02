import { describe, expect, it, vi } from "vitest";
import {
  buildComputeToolDefs,
  type WorkbenchSwitchToolDeps,
} from "../../../src/agent/compute-tools";
import type { WorkSavedToolDeps } from "../../../src/agent/work-saved-tool";

/**
 * Adversarial coverage for `buildComputeToolDefs`'s registration contract.
 * Existing tests exercise the happy path (build the map, call a tool, assert
 * behavior); these instead assert the MAP ITSELF — that the two
 * data-loss-relevant tools appear/disappear exactly when their gates say they
 * should, and that each is wired to the deps bundle it was actually given
 * rather than some other tool's bundle.
 */

function callTool(
  tools: ReturnType<typeof buildComputeToolDefs>,
  name: string,
  input: unknown = {},
) {
  const t = tools[name] as { execute: (i: unknown) => Promise<unknown> } | undefined;
  if (!t) throw new Error(`tool ${name} not registered`);
  return t.execute(input);
}

function makeWorkSavedDeps(): WorkSavedToolDeps & {
  probeSpy: ReturnType<typeof vi.fn>;
  setDeclaredCleanSpy: ReturnType<typeof vi.fn>;
} {
  const probeSpy = vi.fn(async () => ({ state: "clean" as const }));
  const setDeclaredCleanSpy = vi.fn(async () => {});
  return {
    probe: probeSpy,
    setDeclaredClean: setDeclaredCleanSpy,
    threadId: "t1",
    probeSpy,
    setDeclaredCleanSpy,
  };
}

function makeWorkbenchSwitchDeps(): WorkbenchSwitchToolDeps & {
  hasBlockingWorkSpy: ReturnType<typeof vi.fn>;
  adoptSpy: ReturnType<typeof vi.fn>;
} {
  // Resolving `true` short-circuits `commitWorkbenchSwitchIfPending` before it
  // touches `ThreadRepository`/`execShutdown`, so the tool can be exercised
  // without a real D1/service backend — the spy call itself is the assertion.
  const hasBlockingWorkSpy = vi.fn(async () => true);
  const adoptSpy = vi.fn(async () => {});
  return {
    hasBlockingWork: hasBlockingWorkSpy,
    adoptCommittedResourceProfile: adoptSpy,
    hasBlockingWorkSpy,
    adoptSpy,
  };
}

describe("buildComputeToolDefs registration contract", () => {
  describe("confirm_work_saved", () => {
    it("is present when its deps bundle is supplied and there is no attachedRuntime", () => {
      const tools = buildComputeToolDefs(
        async () => ({}) as any,
        async () => ({}) as any,
        { workSaved: makeWorkSavedDeps() },
      );
      expect(tools.confirm_work_saved).toBeDefined();
    });

    it("is absent when attachedRuntime is set, even with deps supplied", () => {
      const tools = buildComputeToolDefs(
        async () => ({}) as any,
        async () => ({}) as any,
        { workSaved: makeWorkSavedDeps(), attachedRuntime: { backend: "daytona", id: "x" } as any },
      );
      expect(tools.confirm_work_saved).toBeUndefined();
    });

    it("is absent without its deps bundle", () => {
      const tools = buildComputeToolDefs(
        async () => ({}) as any,
        async () => ({}) as any,
        {},
      );
      expect(tools.confirm_work_saved).toBeUndefined();
    });
  });

  describe("confirm_workbench_switch", () => {
    it("is present when its deps bundle is supplied and there is no attachedRuntime", () => {
      const tools = buildComputeToolDefs(
        async () => ({}) as any,
        async () => ({}) as any,
        { workbenchSwitch: makeWorkbenchSwitchDeps() },
      );
      expect(tools.confirm_workbench_switch).toBeDefined();
    });

    it("is absent when attachedRuntime is set, even with deps supplied", () => {
      const tools = buildComputeToolDefs(
        async () => ({}) as any,
        async () => ({}) as any,
        {
          workbenchSwitch: makeWorkbenchSwitchDeps(),
          attachedRuntime: { backend: "daytona", id: "x" } as any,
        },
      );
      expect(tools.confirm_workbench_switch).toBeUndefined();
    });

    it("is absent without its deps bundle", () => {
      const tools = buildComputeToolDefs(
        async () => ({}) as any,
        async () => ({}) as any,
        {},
      );
      expect(tools.confirm_workbench_switch).toBeUndefined();
    });
  });

  describe("cross-wiring", () => {
    it("confirm_work_saved reaches its OWN bundle's probe/setDeclaredClean, not confirm_workbench_switch's", async () => {
      const workSaved = makeWorkSavedDeps();
      const workbenchSwitch = makeWorkbenchSwitchDeps();
      const tools = buildComputeToolDefs(
        async () => ({}) as any,
        async () => ({ env: {} as any, threadId: "t1", workspaceId: "w1" }),
        { workSaved, workbenchSwitch },
      );

      await callTool(tools, "confirm_work_saved");

      expect(workSaved.probeSpy).toHaveBeenCalledTimes(1);
      expect(workSaved.setDeclaredCleanSpy).toHaveBeenCalledTimes(1);
      // Invoking confirm_work_saved must not reach into the OTHER bundle.
      expect(workbenchSwitch.hasBlockingWorkSpy).not.toHaveBeenCalled();
      expect(workbenchSwitch.adoptSpy).not.toHaveBeenCalled();
    });

    it("confirm_workbench_switch reaches its OWN bundle's hasBlockingWork/adopt, not confirm_work_saved's", async () => {
      const workSaved = makeWorkSavedDeps();
      const workbenchSwitch = makeWorkbenchSwitchDeps();
      const tools = buildComputeToolDefs(
        async () => ({}) as any,
        async () => ({ env: {} as any, threadId: "t1", workspaceId: "w1" }),
        { workSaved, workbenchSwitch },
      );

      await callTool(tools, "confirm_workbench_switch");

      expect(workbenchSwitch.hasBlockingWorkSpy).toHaveBeenCalledTimes(1);
      // hasBlockingWork resolved true, so the commit short-circuits before
      // adopt is reached — asserted so a future change to that short-circuit
      // is visible here too, not just a silent behavior change.
      expect(workbenchSwitch.adoptSpy).not.toHaveBeenCalled();
      // Invoking confirm_workbench_switch must not reach into the OTHER bundle.
      expect(workSaved.probeSpy).not.toHaveBeenCalled();
      expect(workSaved.setDeclaredCleanSpy).not.toHaveBeenCalled();
    });
  });

  describe("confirm_workbench_switch attachedRuntime gate (levelled up to match confirm_work_saved)", () => {
    it("is absent when attachedRuntime is set even though the deps bundle would otherwise register it", () => {
      const tools = buildComputeToolDefs(
        async () => ({}) as any,
        async () => ({}) as any,
        {
          workbenchSwitch: makeWorkbenchSwitchDeps(),
          attachedRuntime: { backend: "daytona", id: "sub-1" } as any,
        },
      );
      expect(tools.confirm_workbench_switch).toBeUndefined();
    });
  });
});
