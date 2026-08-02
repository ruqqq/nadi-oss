// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useAgentToolEventsMock = vi.hoisted(() => vi.fn());

vi.mock("agents/react", () => ({
  useAgent: vi.fn(),
  useAgentToolEvents: (...args: unknown[]) => useAgentToolEventsMock(...args),
}));

import { useSubagentRuns } from "./use-subagent-runs";

describe("useSubagentRuns capability", () => {
  beforeEach(() => {
    useAgentToolEventsMock.mockReturnValue({
      runsById: {
        sub_old: { runId: "sub_old", status: "completed", summary: "done" },
      },
    });
  });

  it("keeps replay correlation but makes no timing or control calls while disabled", async () => {
    const agent = { call: vi.fn(async () => ({})) };
    const { result } = renderHook(() => useSubagentRuns(agent as never, false));

    await act(async () => {
      await Promise.resolve();
      result.current.cancelRun("sub_old");
      result.current.clearFinished();
    });

    expect(result.current.runsById.sub_old?.summary).toBe("done");
    expect(agent.call).not.toHaveBeenCalled();
  });
});
