import { describe, expect, it } from "vitest";
import { formatSubagentCompletion } from "../../../src/agent/subagent-tools";

describe("formatSubagentCompletion", () => {
  it("leads with the label, keeps the run id at the end, marks truncation", () => {
    const out = formatSubagentCompletion({
      runId: "sub_1",
      label: "repo-scan",
      status: "completed",
      summary: "x".repeat(5000),
    });
    expect(out).toContain('Subagent "repo-scan" finished: completed. [sub_1]');
    expect(out).toContain("…[truncated]");
    expect(out.startsWith("<system-reminder>")).toBe(true);
    expect(out.trimEnd().endsWith("</system-reminder>")).toBe(true);
  });

  it("marks an unlabeled run and frames a failure with the error", () => {
    const out = formatSubagentCompletion({ runId: "sub_2", status: "error", error: "boom" });
    expect(out).toContain("Subagent (unlabeled) finished: error. [sub_2]");
    expect(out).toContain("Error: boom");
  });
});
