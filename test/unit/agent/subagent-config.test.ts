import { describe, expect, it } from "vitest";
import { SUBAGENT_DETACHED } from "../../../src/agent/subagent-config";

describe("SUBAGENT_DETACHED", () => {
  it("disables the resetting no-progress give-up", () => {
    // A subagent doing real work is silent for minutes at a time (a build, a
    // long model turn). The SDK's reconcile backbone gives up after
    // noProgressBudgetMs of silence *once a signal has been reported*; a value
    // of Infinity disables that give-up so only the absolute ceiling bounds a
    // run. See agents/docs/agent-tools.md "Resetting no-progress budget".
    expect(SUBAGENT_DETACHED.noProgressBudgetMs).toBe(Infinity);
  });

  it("bounds a run only by a generous absolute ceiling (>= 30 min)", () => {
    expect(SUBAGENT_DETACHED.maxBudgetMs).toBeGreaterThanOrEqual(30 * 60_000);
  });

  it("keeps the subagent notify source", () => {
    expect(SUBAGENT_DETACHED.notify).toEqual({ source: "subagent" });
  });
});
