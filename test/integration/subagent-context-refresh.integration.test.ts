import { afterEach, describe, expect, it, vi } from "vitest";
import type { TurnConfig, TurnContext } from "@cloudflare/think";
import { SubAgent } from "../../src/agent/subagent";
import { ThinkThreadAgent, type SubagentContext } from "../../src/agent/think-thread-agent";
import { ComputeError } from "../../src/compute/errors";

const POLICY_A_CONTEXT: SubagentContext = {
  parentThreadId: "thread_parent",
  workspaceId: "workspace_1",
  agentId: "agent_1",
  attachedRuntime: {
    provider: "daytona",
    version: 1,
    payload: { kind: "runtime", sandboxId: "sandbox_1" },
  },
};

describe("SubAgent owner context refresh", () => {
  afterEach(() => vi.restoreAllMocks());

  it("revalidates the owner's Daytona egress policy before every child turn", async () => {
    let currentPolicy: "A" | "B" = "A";
    const backendExecution = vi.fn();
    const getSubagentContext = vi.fn(async () => {
      if (currentPolicy === "B") {
        throw new ComputeError(
          "policy_rejected",
          "daytona_egress_policy_changed_run_exec_shutdown",
        );
      }
      return POLICY_A_CONTEXT;
    });

    const child = Object.create(SubAgent.prototype) as SubAgent;
    (child as any).parentAgent = vi.fn(async () => ({ getSubagentContext }));
    (child as any).reportProgress = vi.fn(async () => undefined);
    (child as any).startLiveness = vi.fn();

    const inheritedBeforeTurn = vi
      .spyOn(ThinkThreadAgent.prototype, "beforeTurn")
      .mockImplementation(async () => {
        backendExecution();
        return {} as TurnConfig;
      });
    const turnContext = {} as TurnContext;

    await child.beforeTurn(turnContext);
    currentPolicy = "B";

    await expect(child.beforeTurn(turnContext)).rejects.toMatchObject({ code: "policy_rejected" });
    expect(getSubagentContext).toHaveBeenCalledTimes(2);
    expect(inheritedBeforeTurn).toHaveBeenCalledTimes(1);
    expect(backendExecution).toHaveBeenCalledTimes(1);
  });
});
