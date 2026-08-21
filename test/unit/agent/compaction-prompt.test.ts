import { describe, expect, it } from "vitest";
import { buildCheckpointText, buildPrompt } from "../../../src/agent/compaction";

describe("summary template", () => {
  // buzz asks its summarizer for "one concrete next step". Without it the model
  // re-derives what it was doing, which is how work gets repeated.
  it("demands exactly one concrete next action", () => {
    const prompt = buildPrompt([] as never, null, 500);
    expect(prompt).toContain("## Next Action");
    expect(prompt).toContain("exactly one");
  });

  it("keeps the anti-invention instruction", () => {
    expect(buildPrompt([] as never, null, 500)).toContain("Do NOT invent file paths");
  });
});

describe("buildCheckpointText", () => {
  // deepseek's checkpoint preamble.
  it("tells the model to build on the checkpoint without restating it", () => {
    const text = buildCheckpointText("SUMMARY", "");
    expect(text).toContain("established background");
    expect(text).toContain("without acknowledging this checkpoint");
    expect(text).toContain("SUMMARY");
  });

  it("puts the computed continuity block above the prose summary", () => {
    const text = buildCheckpointText("SUMMARY", "## Work already done\n- Files read: /a");
    expect(text.indexOf("Work already done")).toBeLessThan(text.indexOf("SUMMARY"));
  });

  it("omits the block entirely when there is no continuity to report", () => {
    expect(buildCheckpointText("SUMMARY", "")).not.toContain("Work already done");
  });

  it("is idempotent — framing an already-framed checkpoint does not double the preamble", () => {
    const once = buildCheckpointText("SUMMARY", "");
    const twice = buildCheckpointText(once, "");
    expect(twice.split("established background")).toHaveLength(2);
  });
});
