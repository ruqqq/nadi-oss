import { describe, expect, it, vi } from "vitest";
import {
  createAutomatonOutcomeTools,
  decideAutomatonTurnEnd,
  AUTOMATON_OUTCOME_TOOL_NAME,
} from "../../../src/agent/automaton-outcome-tool";

describe("report_run_outcome tool", () => {
  it("records the declared outcome via the injected state", async () => {
    const recordOutcome = vi.fn().mockResolvedValue(undefined);
    const tools = createAutomatonOutcomeTools({ recordOutcome });
    const tool = tools[AUTOMATON_OUTCOME_TOOL_NAME]!;
    const result = await tool.execute!(
      { status: "blocked", reason: "Foo MCP not configured" },
      {} as never,
    );
    expect(recordOutcome).toHaveBeenCalledWith({
      status: "blocked",
      reason: "Foo MCP not configured",
    });
    expect(typeof result).toBe("string");
  });
});

describe("decideAutomatonTurnEnd", () => {
  it("a pending tool approval wins", () => {
    expect(decideAutomatonTurnEnd({ hasPendingApproval: true, declaredOutcome: null })).toBe(
      "attention_required",
    );
  });
  it("blocked → attention_required", () => {
    expect(
      decideAutomatonTurnEnd({ hasPendingApproval: false, declaredOutcome: { status: "blocked" } }),
    ).toBe("attention_required");
  });
  it("failed → failed", () => {
    expect(
      decideAutomatonTurnEnd({ hasPendingApproval: false, declaredOutcome: { status: "failed" } }),
    ).toBe("failed");
  });
  it("done or no declaration → completed", () => {
    expect(
      decideAutomatonTurnEnd({ hasPendingApproval: false, declaredOutcome: { status: "done" } }),
    ).toBe("completed");
    expect(decideAutomatonTurnEnd({ hasPendingApproval: false, declaredOutcome: null })).toBe(
      "completed",
    );
  });
});
