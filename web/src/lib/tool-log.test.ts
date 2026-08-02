import { describe, expect, it } from "vitest";
import type { ToolUIPart } from "ai";
import { buildToolLogEntry, type DetailBlock } from "./tool-log";
import { resolveToolName } from "./resolve-tool-name";

/**
 * Payloads here mirror the real return shapes — ExecResult and ApplyPatchResult
 * from src/compute, the `{ok:false, error, detail}` failure shape shared by the
 * built-ins, the plain-string returns of the memory tools, and MCP's
 * CallToolResult envelope. A fixture that drifts from those is the bug this
 * whole module exists to avoid.
 */
function part(overrides: Partial<ToolUIPart> & { type: string }): ToolUIPart {
  return {
    toolCallId: "call_1",
    state: "output-available",
    ...overrides,
  } as ToolUIPart;
}

const noServers = resolveToolName("exec", []);

function text(blocks: DetailBlock[], label: string): string | undefined {
  const found = blocks.find((b) => b.kind === "text" && b.label === label);
  return found?.kind === "text" ? found.text : undefined;
}

function notes(blocks: DetailBlock[]): string[] {
  return blocks.filter((b) => b.kind === "note").map((b) => (b.kind === "note" ? b.text : ""));
}

describe("exec", () => {
  const base = {
    ok: true,
    processId: "p1",
    command: "pnpm run typecheck",
    label: null,
    stdoutPreview: "",
    stderrPreview: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };

  it("reserves the accent $ gutter and shows the command as the object", () => {
    const entry = buildToolLogEntry(
      "exec",
      part({ type: "tool-exec", input: { command: "pnpm test" }, output: { ...base, status: "exited", exitCode: 0 } }),
      noServers,
    );
    expect(entry.gutter).toBe("$");
    expect(entry.gutterKind).toBe("exec");
    expect(entry.object).toBe("pnpm test");
    expect(entry.objectMono).toBe(true);
    expect(entry.state).toBe("ok");
  });

  it("prefers a label for the object and demotes the command to the subtitle", () => {
    const entry = buildToolLogEntry(
      "exec",
      part({
        type: "tool-exec",
        input: { command: "pnpm run typecheck", label: "Typecheck" },
        output: { ...base, status: "exited", exitCode: 0, label: "Typecheck" },
      }),
      noServers,
    );
    expect(entry.object).toBe("Typecheck");
    expect(entry.objectMono).toBe(false);
    expect(entry.subtitle).toBe("pnpm run typecheck");
  });

  it("reads a non-zero exit as an error and labels it with the code", () => {
    const entry = buildToolLogEntry(
      "exec",
      part({
        type: "tool-exec",
        input: { command: "pnpm run typecheck" },
        output: { ...base, status: "exited", exitCode: 2, stderrPreview: "TS2379" },
      }),
      noServers,
    );
    expect(entry.state).toBe("error");
    expect(entry.statusLabel).toBe("exit 2");
    expect(text(entry.blocks, "stderr")).toBe("TS2379");
  });

  it("distinguishes a timeout from a plain failure", () => {
    const entry = buildToolLogEntry(
      "exec",
      part({ type: "tool-exec", output: { ...base, status: "failed", timedOut: true, timeoutMs: 5000 } }),
      noServers,
    );
    expect(entry.statusLabel).toBe("timed out");
  });

  it("treats a backgrounded process as its own state, not a failure", () => {
    const entry = buildToolLogEntry(
      "exec",
      part({
        type: "tool-exec",
        input: { command: "pnpm dev" },
        output: {
          ...base,
          status: "backgrounded",
          watching: true,
          backgroundedAfterMs: 10_000,
          message: "Still running.",
          nextActions: [],
        },
      }),
      noServers,
    );
    expect(entry.state).toBe("backgrounded");
    expect(entry.statusLabel).toBe("backgrounded");
    expect(notes(entry.blocks)).toContain("Still running.");
  });

  it("says the preview was truncated rather than offering to expand it", () => {
    // ExecResult carries no full output, so a "show more" control would lie.
    const entry = buildToolLogEntry(
      "exec",
      part({
        type: "tool-exec",
        output: { ...base, status: "exited", exitCode: 0, stdoutPreview: "line", stdoutTruncated: true },
      }),
      noServers,
    );
    expect(notes(entry.blocks)).toContain("Output was truncated to a preview.");
  });
});

describe("file tools", () => {
  it("renders read_file content under its real line range", () => {
    const entry = buildToolLogEntry(
      "read_file",
      part({
        type: "tool-read_file",
        input: { path: "src/db/schema.ts" },
        output: { ok: true, path: "src/db/schema.ts", startLine: 180, endLine: 196, truncated: true, content: "export const threads", hash: "h1" },
      }),
      resolveToolName("read_file", []),
    );
    expect(entry.gutter).toBe("read");
    // The path is the object; printing the basename above the full path said it twice.
    expect(entry.object).toBe("src/db/schema.ts");
    expect(entry.subtitle).toBeUndefined();
    expect(text(entry.blocks, "Lines 180–196")).toBe("export const threads");
    expect(notes(entry.blocks)).toContain("The file continues past this window.");
  });

  it("takes the apply_patch diff from the input, since the result carries only counts", () => {
    const patch = ["*** Begin Patch", "*** Update File: src/db/schema.ts", "+added", "-removed", "*** End Patch"].join("\n");
    const entry = buildToolLogEntry(
      "apply_patch",
      part({
        type: "tool-apply_patch",
        input: { patch, expectedHashes: { "src/db/schema.ts": "h1" } },
        output: { ok: true, operations: 1, written: 1, deleted: 0 },
      }),
      resolveToolName("apply_patch", []),
    );
    expect(entry.gutter).toBe("edit");
    expect(entry.object).toBe("src/db/schema.ts");
    const diff = entry.blocks.find((b) => b.kind === "diff");
    expect(diff?.kind === "diff" && diff.patch).toBe(patch);
    expect(notes(entry.blocks)).toContain("1 file written");
  });

  it("surfaces the error code and detail from the shared failure shape", () => {
    const entry = buildToolLogEntry(
      "write_file",
      part({
        type: "tool-write_file",
        input: { path: "big.bin", content: "x" },
        output: { ok: false, error: "compute_file_too_large", detail: "File exceeds 1MB." },
      }),
      resolveToolName("write_file", []),
    );
    expect(entry.state).toBe("error");
    expect(entry.statusLabel).toBe("compute_file_too_large");
    expect(notes(entry.blocks)).toContain("compute_file_too_large — File exceeds 1MB.");
  });
});

describe("web + memory tools", () => {
  it("counts search results against totalAvailable, not the page size", () => {
    const entry = buildToolLogEntry(
      "web_search",
      part({
        type: "tool-web_search",
        input: { query: "drizzle exactOptionalPropertyTypes" },
        output: {
          results: [
            { title: "Type-safe inserts", url: "https://orm.drizzle.team/docs", snippet: "…" },
            { title: "Issue 1420", url: "https://github.com/drizzle-team/x", snippet: "…" },
          ],
          searchId: "s1",
          totalAvailable: 47,
        },
      }),
      resolveToolName("web_search", []),
    );
    expect(entry.subtitle).toBe("47 results · orm.drizzle.team, github.com");
    const list = entry.blocks.find((b) => b.kind === "list");
    expect(list?.kind === "list" && list.total).toBe(47);
  });

  it("handles the memory tools answering with a plain string", () => {
    const entry = buildToolLogEntry(
      "remember",
      part({ type: "tool-remember", input: { content: "Prefers CI over the local suite", title: "CI" }, output: "remembered: m_1 CI" }),
      resolveToolName("remember", []),
    );
    expect(entry.object).toBe("CI");
    expect(notes(entry.blocks)).toContain("remembered: m_1 CI");
    expect(entry.state).toBe("ok");
  });

  it("reads an error string from a memory tool as a failure", () => {
    const entry = buildToolLogEntry(
      "forget_memory",
      part({ type: "tool-forget_memory", input: { key: "m_1" }, output: "error: failed to forget memory" }),
      resolveToolName("forget_memory", []),
    );
    expect(entry.state).toBe("error");
  });
});

describe("MCP", () => {
  const servers = [{ id: "s1abc", name: "Linear" }];

  it("puts the server in the gutter and the bare tool name in the object", () => {
    const key = "tool_s1abc_create_issue";
    const entry = buildToolLogEntry(
      key,
      part({ type: `tool-${key}`, input: { teamId: "NAD" }, output: { content: [{ type: "text", text: "Created NAD-284" }] } }),
      resolveToolName(key, servers),
    );
    expect(entry.gutter).toBe("Linear");
    expect(entry.gutterKind).toBe("mcp");
    expect(entry.object).toBe("create_issue");
    expect(text(entry.blocks, "Returned")).toBe("Created NAD-284");
  });

  it("renders a text content block as text, not as its envelope", () => {
    const key = "tool_s1abc_read";
    const entry = buildToolLogEntry(
      key,
      part({ type: `tool-${key}`, output: { content: [{ type: "text", text: "# Roadmap" }, { type: "image", data: "…", mimeType: "image/png" }] } }),
      resolveToolName(key, servers),
    );
    expect(text(entry.blocks, "Returned")).toBe("# Roadmap");
    expect(notes(entry.blocks)).toContain("Also returned image");
  });

  it("prefers structuredContent when the server sends it", () => {
    const key = "tool_s1abc_get_issue";
    const entry = buildToolLogEntry(
      key,
      part({ type: `tool-${key}`, output: { content: [], structuredContent: { identifier: "NAD-284", state: "Todo" } } }),
      resolveToolName(key, servers),
    );
    const fields = entry.blocks.find((b) => b.kind === "fields");
    expect(fields?.kind === "fields" && fields.fields).toEqual([
      { key: "identifier", value: "NAD-284" },
      { key: "state", value: "Todo" },
    ]);
  });

  it("treats isError as a failure", () => {
    const key = "tool_s1abc_list_issues";
    const entry = buildToolLogEntry(
      key,
      part({ type: `tool-${key}`, output: { isError: true, content: [{ type: "text", text: "missing scope" }] } }),
      resolveToolName(key, servers),
    );
    expect(entry.state).toBe("error");
    const block = entry.blocks.find((b) => b.kind === "text");
    expect(block?.kind === "text" && block.label).toBe("Failed");
    expect(block?.kind === "text" && block.tone).toBe("error");
  });

  it("understands the legacy toolResult envelope", () => {
    const key = "tool_s1abc_ping";
    const entry = buildToolLogEntry(
      key,
      part({ type: `tool-${key}`, output: { toolResult: "pong" } }),
      resolveToolName(key, servers),
    );
    expect(text(entry.blocks, "Returned")).toBe("pong");
  });

  it("falls back to the raw key when the server is not loaded", () => {
    const key = "tool_unknown_list_dashboards";
    const entry = buildToolLogEntry(key, part({ type: `tool-${key}`, output: {} }), resolveToolName(key, servers));
    expect(entry.gutterKind).toBe("raw");
    expect(entry.object).toBe(key);
    expect(entry.subtitle).toBe("Server not loaded — showing the raw key");
  });

  it("promotes an oversized field out of the grid into its own block", () => {
    // An MCP `write` carries a whole document under `content`; rendered as a
    // table cell it dumped thousands of characters into the row.
    const key = "tool_s1abc_write";
    const document = "# Digest\n".repeat(400);
    const entry = buildToolLogEntry(
      key,
      part({
        type: `tool-${key}`,
        input: { filename: "/opds/reddit/digest.md", mode: "create", content: document },
        output: { content: [{ type: "text", text: "written" }] },
      }),
      resolveToolName(key, servers),
    );
    const fields = entry.blocks.find((b) => b.kind === "fields");
    expect(fields?.kind === "fields" && fields.fields.map((f) => f.key)).toEqual([
      "filename",
      "mode",
    ]);
    const promoted = entry.blocks.find((b) => b.kind === "text" && b.label === "content");
    expect(promoted?.kind === "text" && promoted.text).toBe(document);
    expect(promoted?.kind === "text" && promoted.wrap).toBe(true);
  });

  it("keeps a short field in the grid", () => {
    const key = "tool_s1abc_write";
    const entry = buildToolLogEntry(
      key,
      part({ type: `tool-${key}`, input: { content: "hello" }, output: {} }),
      resolveToolName(key, servers),
    );
    const fields = entry.blocks.find((b) => b.kind === "fields");
    expect(fields?.kind === "fields" && fields.fields).toEqual([{ key: "content", value: "hello" }]);
  });

  it("drops to JSON when a returned object nests", () => {
    const key = "tool_s1abc_tree";
    const entry = buildToolLogEntry(
      key,
      part({ type: `tool-${key}`, output: { structuredContent: { root: { child: 1 } } } }),
      resolveToolName(key, servers),
    );
    expect(entry.blocks.some((b) => b.kind === "json")).toBe(true);
  });
});

describe("states that are not success", () => {
  it("replaces the detail of a denied call with a plain explanation", () => {
    const entry = buildToolLogEntry(
      "exec",
      part({ type: "tool-exec", state: "output-denied", input: { command: "rm -rf /" } }),
      noServers,
    );
    expect(entry.state).toBe("denied");
    expect(entry.statusLabel).toBe("denied");
    expect(entry.blocks).toEqual([{ kind: "note", text: "You declined this call." }]);
  });

  it("marks a still-running call", () => {
    const entry = buildToolLogEntry(
      "exec",
      part({ type: "tool-exec", state: "input-available", input: { command: "pnpm test" } }),
      noServers,
    );
    expect(entry.state).toBe("running");
  });

  it("leads with errorText when the SDK reports a tool error", () => {
    const entry = buildToolLogEntry(
      "exec",
      part({ type: "tool-exec", state: "output-error", input: { command: "x" }, errorText: "sandbox unreachable" }),
      noServers,
    );
    expect(entry.state).toBe("error");
    expect(notes(entry.blocks)[0]).toBe("sandbox unreachable");
  });

  it("derives a verb for a built-in with no hand-written gutter", () => {
    // Gutter and object sit side by side, so the row reads back as the phrase
    // the friendly name already was: "confirm | Work saved".
    const entry = buildToolLogEntry(
      "confirm_work_saved",
      part({ type: "tool-confirm_work_saved", input: {}, output: { ok: true } }),
      resolveToolName("confirm_work_saved", []),
    );
    expect(entry.gutter).toBe("confirm");
    expect(entry.gutterKind).toBe("verb");
    expect(entry.object).toBe("Work saved");
  });

  it("derives from the curated friendly name, not the raw key", () => {
    // getAttachmentUrl is curated to "Open attachment" — deriving from the key
    // would say "get" over an object that says "Open".
    const entry = buildToolLogEntry(
      "getAttachmentUrl",
      part({ type: "tool-getAttachmentUrl", input: {}, output: { ok: true } }),
      resolveToolName("getAttachmentUrl", []),
    );
    expect(entry.gutter).toBe("open");
    expect(entry.object).toBe("Attachment");
  });

  it("falls back to a generic verb when the name is a single word", () => {
    const entry = buildToolLogEntry(
      "ping",
      part({ type: "tool-ping", input: {}, output: { ok: true } }),
      resolveToolName("ping", []),
    );
    expect(entry.gutter).toBe("call");
    expect(entry.object).toBe("Ping");
  });

  it("never derives over a hand-written gutter", () => {
    const entry = buildToolLogEntry(
      "read_file",
      part({ type: "tool-read_file", input: { path: "a.ts" }, output: { ok: true, path: "a.ts" } }),
      resolveToolName("read_file", []),
    );
    expect(entry.gutter).toBe("read");
  });
});
