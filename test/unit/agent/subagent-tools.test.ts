import { describe, expect, it } from "vitest";
import {
  createSubagentTools,
  formatSubagentCompletion,
  unwrapStoredInputPreview,
} from "../../../src/agent/subagent-tools";

// Mirror of the client's completion-detection regex (web/src/lib/subagent-runs.ts
// SUBAGENT_COMPLETION_RE): a subagent completion only renders as the result card
// when its text matches this. Duplicated here to pin the cross-package contract —
// keep this in sync with the client's copy, quote-tolerance included.
const SUBAGENT_COMPLETION_RE =
  /^<system-reminder>\s*Subagent (?:"([\s\S]*?)"(?= finished: )|\(unlabeled\)) finished: (\w+)\.\s*\[([^\]]+)\]\s*([\s\S]*?)\s*<\/system-reminder>\s*$/;

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
  /**
   * Skipping the unwrap and handing the raw JSON-encoded `input_preview`
   * column straight to `formatSubagentCompletion` used to break the client's
   * regex outright (the doubled quotes `""scan the repo""` could not match a
   * strict `"([^"]*)"` capture). It no longer breaks the MATCH — sanitizing
   * quotes before wrapping (this describe block's other test) happens to
   * absorb this simple case too — but the label text is still wrong unless
   * unwrapped first: this case just doesn't reveal it, because a plain string
   * has no internal escaping for the strip to mangle. `formatSubagentCompletion`
   * sanitizing quotes is belt-and-braces, not a replacement for unwrapping.
   */
  it("renders correct label text only once the JSON-stored label is unwrapped", () => {
    const stored = JSON.stringify("scan the repo"); // how the SDK stores input_preview
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

  /**
   * Where skipping the unwrap actually still mangles the label: JSON escapes
   * an embedded quote as `\"`, and stripping raw `"` characters from the
   * still-encoded column value leaves the stray backslash behind — a
   * corrupted label the regex happily matches anyway. Unwrapping first (via
   * `unwrapStoredInputPreview`) is the real fix; the formatter's quote strip
   * only prevents a broken RENDER, not a broken label.
   */
  it("still corrupts the label if the raw JSON-encoded column value skips unwrapping", () => {
    const original = 'the project "Markdump"';
    const stored = JSON.stringify(original);
    const stillEncoded = formatSubagentCompletion({
      runId: "sub_1",
      label: stored,
      status: "completed",
      summary: "done",
    });
    const brokenMatch = SUBAGENT_COMPLETION_RE.exec(stillEncoded);
    expect(brokenMatch).not.toBeNull();
    expect(brokenMatch?.[1]).not.toBe(original);

    const label = unwrapStoredInputPreview(stored);
    if (!label) throw new Error("expected a label");
    const fixed = formatSubagentCompletion({
      runId: "sub_1",
      label,
      status: "completed",
      summary: "done",
    });
    const m = SUBAGENT_COMPLETION_RE.exec(fixed);
    // The unwrapped label itself had embedded quotes — the production bug's
    // actual trigger — which the formatter strips before wrapping.
    expect(m?.[1]).toBe("the project Markdump");
  });

  /**
   * The production bug this whole chain traces back to: a task/label
   * containing double quotes (`the project "Markdump"`) broke the client
   * regex outright, because `formatSubagentCompletion` did not sanitize the
   * label before wrapping it in quotes. It now strips `"` from the label —
   * belt-and-braces alongside `deriveRunLabel` sanitizing at the SOURCE
   * (`display.name`) and the client regex being quote-tolerant.
   */
  it("strips embedded quotes from the label before wrapping it", () => {
    const text = formatSubagentCompletion({
      runId: "sub_1",
      label: 'the project "Markdump"',
      status: "completed",
      summary: "done",
    });
    const m = SUBAGENT_COMPLETION_RE.exec(text);
    expect(m).not.toBeNull();
    expect(m?.[1]).toBe("the project Markdump");
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
    expect(out).toMatchObject({ runId: "run-1", status: "started" });
    // The result carries the follow-up instructions: the model must not redo the
    // work, and the real result arrives later as its own message.
    expect((out as { note: string }).note).toMatch(/does NOT come back through this tool/);
  });

  it("surfaces a wait message when dispatch is rejected (cap exceeded)", async () => {
    const tools = createSubagentTools({
      spawn: async () => ({ error: "too_many_active_subagents" }),
      list: noRuns,
    });
    const out = await call(tools.spawn_subagent, { task: "do a thing" });
    expect(out).toMatchObject({ status: "rejected", error: "too_many_active_subagents" });
    // Rejected means nothing is running — tell the model not to wait for a result.
    expect((out as { note: string }).note).toMatch(/No subagent was launched/);
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
    // One run is still running, so the result also tells the model not to poll.
    expect(out).toEqual({ runs, note: expect.stringContaining("Do not call this tool in a loop") });
  });

  it("omits the keep-waiting note once every run has finished", async () => {
    const runs = [{ runId: "sub_2", label: "build", status: "completed", summary: "PR opened" }];
    const tools = createSubagentTools({
      spawn: async () => ({ runId: "x" }),
      list: async () => runs,
    });
    expect(await call(tools.check_subagents, {})).toEqual({ runs });
  });

  it("returns an explanatory note when there are no runs", async () => {
    const tools = createSubagentTools({ spawn: async () => ({ runId: "x" }), list: noRuns });
    const out = await call(tools.check_subagents, {});
    expect(out).toEqual({ runs: [], note: expect.stringContaining("No subagents") });
  });
});
