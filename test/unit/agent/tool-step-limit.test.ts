import { describe, expect, it } from "vitest";
import {
  CODING_MAX_TOOL_STEPS,
  MAX_TOOL_STEPS,
  TOOL_LIMIT_WINDDOWN_DIRECTIVE,
  isFinalToolStep,
  resolveToolStepBudget,
  windDownSystemPrompt,
} from "../../../src/agent/tool-step-limit";

describe("tool-step-limit", () => {
  it("caps at 50 steps", () => {
    expect(MAX_TOOL_STEPS).toBe(50);
  });

  it("gives a declared coding task a larger finite backstop", () => {
    expect(CODING_MAX_TOOL_STEPS).toBe(500);
  });

  it("resolves the budget from whether the thread has a workbench", () => {
    expect(resolveToolStepBudget(true)).toBe(CODING_MAX_TOOL_STEPS);
    expect(resolveToolStepBudget(false)).toBe(MAX_TOOL_STEPS);
  });

  it("winds down at the final step of the coding budget too", () => {
    expect(isFinalToolStep(CODING_MAX_TOOL_STEPS - 1, CODING_MAX_TOOL_STEPS)).toBe(true);
    expect(isFinalToolStep(MAX_TOOL_STEPS - 1, CODING_MAX_TOOL_STEPS)).toBe(false);
  });

  it("only the final allowed step triggers wind-down", () => {
    expect(isFinalToolStep(MAX_TOOL_STEPS - 1)).toBe(true);
    expect(isFinalToolStep(0)).toBe(false);
    expect(isFinalToolStep(MAX_TOOL_STEPS - 2)).toBe(false);
  });

  it("honors a custom maxSteps budget", () => {
    expect(isFinalToolStep(3, 4)).toBe(true);
    expect(isFinalToolStep(2, 4)).toBe(false);
    expect(isFinalToolStep(0, 1)).toBe(true);
  });

  it("appends the wind-down directive to the system prompt", () => {
    const result = windDownSystemPrompt("BASE");
    expect(result.startsWith("BASE")).toBe(true);
    expect(result).toContain(TOOL_LIMIT_WINDDOWN_DIRECTIVE);
  });
});
