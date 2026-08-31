import { describe, expect, it, vi } from "vitest";
import { buildComputeToolDefs } from "../../../src/agent/compute-tools";
import type { WorkSavedToolDeps } from "../../../src/agent/work-saved-tool";

/**
 * Adversarial coverage for `buildComputeToolDefs`'s registration contract.
 * Existing tests exercise the happy path (build the map, call a tool, assert
 * behavior); these instead assert the MAP ITSELF — that the
 * data-loss-relevant tool appears/disappears exactly when its gate says it
 * should, and that it is wired to the deps bundle it was actually given.
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

  describe("cross-wiring", () => {
    it("confirm_work_saved reaches its OWN bundle's probe/setDeclaredClean", async () => {
      const workSaved = makeWorkSavedDeps();
      const tools = buildComputeToolDefs(
        async () => ({}) as any,
        async () => ({ env: {} as any, threadId: "t1", workspaceId: "w1" }),
        { workSaved },
      );

      await callTool(tools, "confirm_work_saved");

      expect(workSaved.probeSpy).toHaveBeenCalledTimes(1);
      expect(workSaved.setDeclaredCleanSpy).toHaveBeenCalledTimes(1);
    });
  });
});
