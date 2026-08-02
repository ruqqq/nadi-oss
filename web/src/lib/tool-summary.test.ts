import { describe, expect, it } from "vitest";
import type { ToolUIPart } from "ai";
import { getRunToolLine, getSingleToolLine, summarizePatch } from "./tool-summary";

function part(input: unknown, output?: unknown): ToolUIPart {
  return {
    type: "tool-test",
    toolCallId: "tc_1",
    state: output === undefined ? "input-available" : "output-available",
    input,
    output,
  } as ToolUIPart;
}

const PATCH = [
  "*** Begin Patch",
  "*** Update File: web/src/next.config.ts",
  "@@",
  " keep",
  "-old",
  "+new one",
  "+new two",
  "*** End Patch",
].join("\n");

describe("summarizePatch", () => {
  it("counts added/removed and collects the path", () => {
    expect(summarizePatch(PATCH)).toEqual({
      paths: ["web/src/next.config.ts"],
      added: 2,
      removed: 1,
    });
  });
});

describe("getSingleToolLine", () => {
  it("edits read as 'Edited <file> +N −M'", () => {
    expect(getSingleToolLine("apply_patch", part({ patch: PATCH }), "Apply patch")).toEqual({
      segments: [
        { text: "Edited" },
        { text: "next.config.ts", mono: true },
        { text: "+2", tone: "add" },
        { text: "−1", tone: "del" },
      ],
    });
  });

  it("collapses a multi-file patch to a count", () => {
    const multi = [
      "*** Begin Patch",
      "*** Update File: a.ts",
      "@@",
      "-x",
      "+y",
      "*** Add File: b.ts",
      "+z",
      "*** End Patch",
    ].join("\n");
    expect(getSingleToolLine("apply_patch", part({ patch: multi }), "Apply patch").segments[0]).toEqual(
      { text: "Edited 2 files" },
    );
  });

  it("commands read as 'Ran <command>'", () => {
    expect(getSingleToolLine("exec", part({ command: "pnpm test", label: "Run tests" }), "Run").segments).toEqual([
      { text: "Ran" },
      { text: "pnpm test", mono: true },
    ]);
  });

  it("writes read as 'Wrote <file>'", () => {
    expect(
      getSingleToolLine("write_file", part({ path: "web/src/cache.ts" }, { ok: true }), "Write file")
        .segments,
    ).toEqual([{ text: "Wrote" }, { text: "cache.ts", mono: true }]);
  });

  it("web search reads as 'Searched the web' with a faint host tail", () => {
    const line = getSingleToolLine(
      "web_search",
      part(
        { query: "react cache" },
        { results: [{ url: "https://react.dev/x" }, { url: "https://github.com/y" }] },
      ),
      "Search the web",
    );
    expect(line.segments).toEqual([
      { text: "Searched the web" },
      { text: "· react.dev, github.com", tone: "faint" },
    ]);
  });

  it("subagents read as 'Started a subagent' with the task as a faint tail", () => {
    expect(
      getSingleToolLine("spawn_subagent", part({ task: "Audit migrations" }, { status: "started" }), "x")
        .segments,
    ).toEqual([{ text: "Started a subagent" }, { text: "· Audit migrations", tone: "faint" }]);
  });

  it("falls back to the friendly label for tools without a verb", () => {
    expect(getSingleToolLine("tool_s1_search_docs", part({}), "Markdump · search").segments).toEqual([
      { text: "Markdump · search" },
    ]);
  });

  it("uses the noun with an article when there is no object", () => {
    expect(getSingleToolLine("read_file", part({}), "Read file").segments).toEqual([
      { text: "Read a file" },
    ]);
  });
});

describe("getRunToolLine", () => {
  it("summarizes a mixed run by verb with counts and a summed diff", () => {
    const entries = [
      { toolName: "exec", part: part({ command: "a" }, { exitCode: 0 }) },
      { toolName: "exec", part: part({ command: "b" }, { exitCode: 0 }) },
      { toolName: "exec", part: part({ command: "c" }, { exitCode: 0 }) },
      { toolName: "read_file", part: part({ path: "a.ts" }, { ok: true }) },
      { toolName: "read_file", part: part({ path: "b.ts" }, { ok: true }) },
      { toolName: "apply_patch", part: part({ patch: PATCH }, { ok: true }) },
    ];
    expect(getRunToolLine(entries)).toEqual({
      segments: [
        { text: "Ran 3 commands, read 2 files, edited a file" },
        { text: "+2", tone: "add" },
        { text: "−1", tone: "del" },
      ],
    });
  });

  it("lowercases non-leading verbs and uses articles for singletons", () => {
    const entries = [
      { toolName: "read_file", part: part({ path: "a.ts" }, { ok: true }) },
      { toolName: "exec", part: part({ command: "x" }, { exitCode: 0 }) },
    ];
    expect(getRunToolLine(entries).segments[0]).toEqual({ text: "Read a file, ran a command" });
  });

  it("falls back to 'Ran N tools' for unknown tools", () => {
    const entries = [
      { toolName: "tool_s1_a", part: part({}) },
      { toolName: "tool_s1_b", part: part({}) },
    ];
    expect(getRunToolLine(entries).segments[0]).toEqual({ text: "Ran 2 tools" });
  });
});
