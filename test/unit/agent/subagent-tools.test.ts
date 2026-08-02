import { describe, expect, it } from "vitest";
import {
  createSubagentTools,
  formatSubagentCompletion,
  unwrapStoredInputPreview,
} from "../../../src/agent/subagent-tools";

// Mirror of the client's completion-detection regex (web/src/lib/subagent-runs.ts
// SUBAGENT_COMPLETION_RE): a subagent completion only renders as the result card
// when its text matches this. Duplicated here to pin the cross-package contract.
const SUBAGENT_COMPLETION_RE =
  /^<system-reminder>\s*Subagent (?:"([^"]*)"|\(unlabeled\)) finished: (\w+)\.\s*\[([^\]]+)\]\s*([\s\S]*?)\s*<\/system-reminder>\s*$/;

describe("unwrapStoredInputPreview", () => {
  it("parses a JSON-encoded string back to the clean value", () => {
    expect(unwrapStoredInputPreview('"Use exec to run: sleep 8"')).toBe("Use exec to run: sleep 8");
  });
  it("returns undefined for undefined", () => {
    expect(unwrapStoredInputPreview(undefined)).toBeUndefined();
  });
  it("falls back to the raw value for non-JSON or non-string-parse input", () => {
    expect(unwrapStoredInputPreview("not json")).toBe("not json");
    expect(unwrapStoredInputPreview("123")).toBe("123");
    expect(unwrapStoredInputPreview('{"a":1}')).toBe('{"a":1}');
  });
});

describe("formatSubagentCompletion label wrapping", () => {
  it("renders as a card only once the JSON-stored label is unwrapped", () => {
    const stored = JSON.stringify("scan the repo"); // how the SDK stores input_preview
    // Raw (double-encoded) label breaks the client regex -> plain bubble, no card.
    const broken = formatSubagentCompletion({
      runId: "sub_1",
      label: stored,
      status: "completed",
      summary: "done",
    });
    expect(SUBAGENT_COMPLETION_RE.test(broken)).toBe(false);
    // Unwrapped label roundtrips through the regex -> card renders.
    const label = unwrapStoredInputPreview(stored);
    if (!label) throw new Error("expected a label");
    const fixed = formatSubagentCompletion({
      runId: "sub_1",
      label,
      status: "completed",
      summary: "done",
    });
    const m = SUBAGENT_COMPLETION_RE.exec(fixed);
    expect(m?.[1]).toBe("scan the repo");
    expect(m?.[2]).toBe("completed");
    expect(m?.[3]).toBe("sub_1");
  });
});

async function call(tool: any, args: unknown) {
  return tool.execute(args, { toolCallId: "t1", messages: [] });
}

const noRuns = async () => [];

describe("spawn_subagent tool", () => {
  it("returns a started runId on success", async () => {
    const tools = createSubagentTools({ spawn: async () => ({ runId: "run-1" }), list: noRuns });
    const out = await call(tools.spawn_subagent, { task: "investigate the failing test" });
    expect(out).toEqual({ runId: "run-1", status: "started" });
  });

  it("surfaces a wait message when dispatch is rejected (cap exceeded)", async () => {
    const tools = createSubagentTools({
      spawn: async () => ({ error: "too_many_active_subagents" }),
      list: noRuns,
    });
    const out = await call(tools.spawn_subagent, { task: "do a thing" });
    expect(out).toEqual({ status: "rejected", error: "too_many_active_subagents" });
  });

  it("forwards the tool call id to spawn (so the run can bind to the tool call)", async () => {
    let captured: { task: string; label?: string; toolCallId?: string } | undefined;
    const tools = createSubagentTools({
      spawn: async (input) => {
        captured = input;
        return { runId: "run-1" };
      },
      list: noRuns,
    });
    // `call` invokes execute with `{ toolCallId: "t1", messages: [] }`.
    await call(tools.spawn_subagent, { task: "do a thing", label: "L" });
    expect(captured).toMatchObject({ task: "do a thing", label: "L", toolCallId: "t1" });
  });
});

describe("check_subagents tool", () => {
  it("returns the runs from list()", async () => {
    const runs = [
      { runId: "sub_1", label: "probe", status: "running" },
      { runId: "sub_2", label: "build", status: "completed", summary: "PR opened" },
    ];
    const tools = createSubagentTools({
      spawn: async () => ({ runId: "x" }),
      list: async () => runs,
    });
    const out = await call(tools.check_subagents, {});
    expect(out).toEqual({ runs });
  });

  it("returns an explanatory note when there are no runs", async () => {
    const tools = createSubagentTools({ spawn: async () => ({ runId: "x" }), list: noRuns });
    const out = await call(tools.check_subagents, {});
    expect(out).toEqual({ runs: [], note: expect.stringContaining("No subagents") });
  });
});
