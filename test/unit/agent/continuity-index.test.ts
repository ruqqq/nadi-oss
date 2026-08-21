import { describe, expect, it } from "vitest";
import {
  boundContinuity,
  EMPTY_CONTINUITY,
  extractContinuity,
  mergeContinuity,
  renderContinuity,
} from "../../../src/agent/continuity-index";

const tool = (name: string, input: unknown, output: unknown, id = name) => ({
  id: `m-${id}`,
  role: "assistant" as const,
  parts: [
    {
      type: `tool-${name}`,
      toolName: name,
      toolCallId: id,
      state: "output-available",
      input,
      output,
    },
  ],
});

describe("extractContinuity", () => {
  it("returns the empty index for a transcript with no tool calls", () => {
    expect(extractContinuity([{ parts: [{ type: "text", text: "hi" }] }])).toEqual(
      EMPTY_CONTINUITY,
    );
  });

  it("records files read and written under their own keys", () => {
    const index = extractContinuity([
      tool("read_file", { path: "src/a.ts" }, { ok: true }),
      tool("write_file", { path: "src/b.ts" }, { ok: true }),
    ]);
    expect(index.filesRead).toEqual(["src/a.ts"]);
    expect(index.filesWritten).toEqual(["src/b.ts"]);
  });

  // apply_patch carries NO `path`: its touched files are the KEYS of
  // expectedHashes (compute-file-tools.ts:121). Reading `input.path` here
  // silently records nothing.
  it("records every path an apply_patch touched, from expectedHashes", () => {
    const index = extractContinuity([
      tool(
        "apply_patch",
        {
          patch: "*** Begin Patch\n*** End Patch",
          expectedHashes: { "src/c.ts": "h1", "src/d.ts": "h2" },
        },
        { ok: true },
      ),
    ]);
    expect(index.filesWritten).toEqual(["src/c.ts", "src/d.ts"]);
  });

  it("de-duplicates repeated reads and keeps first-seen order", () => {
    const index = extractContinuity([
      tool("read_file", { path: "/a" }, {}, "r1"),
      tool("read_file", { path: "/b" }, {}, "r2"),
      tool("read_file", { path: "/a" }, {}, "r3"),
    ]);
    expect(index.filesRead).toEqual(["/a", "/b"]);
  });

  // The failure this design exists to prevent: after a compaction the model
  // re-ran an investigation a subagent had already completed.
  it("records subagent runs with their outcomes", () => {
    const index = extractContinuity([
      tool(
        "spawn_subagent",
        { task: "map the PR", label: "Map PR" },
        { runId: "sub_1", status: "started" },
      ),
    ]);
    expect(index.subagents).toEqual([{ runId: "sub_1", label: "Map PR", outcome: "started" }]);
  });

  it("records published artifacts with their URLs", () => {
    const index = extractContinuity([
      tool(
        "exec_publish_artifact",
        { path: "out", entryPath: "x.html" },
        { artifactId: "art_1", title: "Explain diff", url: "/api/artifacts/art_1" },
      ),
    ]);
    expect(index.artifacts).toEqual([{ title: "Explain diff", url: "/api/artifacts/art_1" }]);
  });

  it("ignores a tool part that has not produced output yet", () => {
    const index = extractContinuity([
      {
        parts: [
          {
            type: "tool-read_file",
            toolName: "read_file",
            toolCallId: "x",
            state: "input-available",
            input: { path: "/a" },
          },
        ],
      },
    ]);
    expect(index.filesRead).toEqual([]);
  });

  // This runs inside the compaction path. An exception here turns a recoverable
  // context-pressure event into a failed turn.
  it("never throws on a malformed or unexpected tool shape", () => {
    expect(() =>
      extractContinuity([
        tool("read_file", null, { ok: true }, "a"),
        tool("apply_patch", { expectedHashes: "not-a-map" }, {}, "b"),
        tool("spawn_subagent", {}, "not-an-object", "c"),
        tool("exec_publish_artifact", {}, { url: 42 }, "d"),
        { parts: undefined as unknown as [] },
      ]),
    ).not.toThrow();
  });
});

describe("mergeContinuity", () => {
  // A second compaction summarizes a span that no longer holds the first
  // span's tool calls. Without a merge the index forgets everything the
  // previous checkpoint knew — the failure pi's CompactionDetails merge exists
  // to prevent.
  it("merges a later index over an earlier one without losing the earlier entries", () => {
    const first = {
      ...EMPTY_CONTINUITY,
      filesRead: ["/a"],
      subagents: [{ runId: "s1", label: "one", outcome: "completed" }],
    };
    const second = { ...EMPTY_CONTINUITY, filesRead: ["/b"], filesWritten: ["/c"] };

    const merged = mergeContinuity(first, second);

    expect(merged.filesRead).toEqual(["/a", "/b"]);
    expect(merged.filesWritten).toEqual(["/c"]);
    expect(merged.subagents).toHaveLength(1);
  });

  it("de-duplicates across the merge", () => {
    const merged = mergeContinuity(
      { ...EMPTY_CONTINUITY, filesRead: ["/a"] },
      { ...EMPTY_CONTINUITY, filesRead: ["/a", "/b"] },
    );
    expect(merged.filesRead).toEqual(["/a", "/b"]);
  });

  it("lets a later scalar win but never clears one with undefined", () => {
    expect(
      mergeContinuity(
        { ...EMPTY_CONTINUITY, branch: "main" },
        { ...EMPTY_CONTINUITY, branch: "feature" },
      ).branch,
    ).toBe("feature");
    expect(mergeContinuity({ ...EMPTY_CONTINUITY, branch: "main" }, EMPTY_CONTINUITY).branch).toBe(
      "main",
    );
  });

  it("updates a subagent's outcome when a later index reports it finished", () => {
    const merged = mergeContinuity(
      { ...EMPTY_CONTINUITY, subagents: [{ runId: "s1", label: "one", outcome: "started" }] },
      { ...EMPTY_CONTINUITY, subagents: [{ runId: "s1", label: "one", outcome: "completed" }] },
    );
    expect(merged.subagents).toEqual([{ runId: "s1", label: "one", outcome: "completed" }]);
  });
});

describe("boundContinuity", () => {
  // The index sits inside the post-compaction floor. Unbounded, it recreates
  // the bug plan A just fixed.
  it("bounds the rendered index by dropping the OLDEST file entries first", () => {
    const many = {
      ...EMPTY_CONTINUITY,
      filesRead: Array.from({ length: 500 }, (_, i) => `/f${i}`),
    };

    const bounded = boundContinuity(many, 400);

    expect(renderContinuity(bounded).length).toBeLessThanOrEqual(400);
    // Recent files are what the next turn needs.
    expect(bounded.filesRead.at(-1)).toBe("/f499");
  });

  it("keeps subagent entries even under pressure", () => {
    const index = {
      ...EMPTY_CONTINUITY,
      filesRead: Array.from({ length: 500 }, (_, i) => `/f${i}`),
      subagents: [{ runId: "s1", label: "mapped the PR", outcome: "completed" }],
    };

    const bounded = boundContinuity(index, 300);

    expect(bounded.subagents).toHaveLength(1);
    expect(renderContinuity(bounded)).toContain("mapped the PR");
  });
});

describe("renderContinuity", () => {
  it("renders nothing for an empty index, so no empty block reaches the model", () => {
    expect(renderContinuity(EMPTY_CONTINUITY)).toBe("");
  });

  it("names what was read, written, delegated, and published", () => {
    const text = renderContinuity({
      filesRead: ["/a"],
      filesWritten: ["/b"],
      branch: "feature",
      subagents: [{ runId: "s1", label: "map the PR", outcome: "completed" }],
      artifacts: [{ title: "Explain diff", url: "/api/artifacts/art_1" }],
    });
    expect(text).toContain("/a");
    expect(text).toContain("/b");
    expect(text).toContain("feature");
    expect(text).toContain("map the PR");
    expect(text).toContain("/api/artifacts/art_1");
  });
});
