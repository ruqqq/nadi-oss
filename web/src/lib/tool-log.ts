import type { ToolUIPart } from "ai";
import { friendlyToolName } from "./friendly-tool-name";
import type { ResolvedToolName } from "./resolve-tool-name";
import { summarizePatch } from "./tool-summary";

/**
 * Turns one tool call into a row of the run log: a gutter that says what KIND
 * of call it was, the object it acted on, and the blocks that make up its
 * detail. Per-tool knowledge lives here and only here — adding a tool means
 * editing one switch, not keeping a summary map and a detail map in sync.
 *
 * Everything is derived from the shapes the tools actually return (see
 * src/agent/*-tools.ts and src/compute/file-service.ts). Where a payload does
 * not carry something, this module says so rather than inventing an affordance:
 * `exec` returns bounded stdout/stderr previews with truncation flags and no
 * way to fetch the rest, so a truncated preview renders a note, never a
 * "show more" that cannot deliver.
 */

export type BlockTone = "plain" | "error";

export interface DetailField {
  key: string;
  value: string;
}

export interface DetailListItem {
  primary: string;
  secondary?: string;
}

export type DetailBlock =
  /** `wrap` marks prose (an MCP text result) rather than aligned output. */
  | { kind: "text"; label: string; text: string; tone?: BlockTone; wrap?: boolean }
  | { kind: "diff"; label: string; patch: string }
  | { kind: "fields"; label: string; fields: DetailField[] }
  | { kind: "list"; label: string; items: DetailListItem[]; total: number }
  | { kind: "json"; label: string; json: string }
  | { kind: "note"; text: string; tone?: BlockTone };

/** Drives the gutter colour: the accent `$` is reserved for a real shell. */
export type GutterKind = "exec" | "verb" | "mcp" | "raw" | "none";

export type ToolRowState = "ok" | "error" | "denied" | "running" | "backgrounded";

export interface ToolLogEntry {
  gutter: string;
  gutterKind: GutterKind;
  object: string;
  /** The object is a path, command, or identifier — render it mono. */
  objectMono: boolean;
  subtitle?: string;
  state: ToolRowState;
  /** Short status word shown as a chip; omitted when the call simply succeeded. */
  statusLabel?: string;
  blocks: DetailBlock[];
}

/** How many rows of a list result are shown before the count takes over. */
export const LIST_PREVIEW_LIMIT = 3;

/** Collapse a multi-line shell command to a single readable row title. */
function oneLineCommand(command: string, max = 72): string {
  const first = command.split(/\r?\n/)[0]?.replace(/\s+/g, " ").trim() ?? command.trim();
  if (first.length <= max) return first;
  return `${first.slice(0, max - 1)}…`;
}

// The gutter verb per built-in tool. Absent → the row leads with its friendly
// name and no gutter, which is what unmapped built-ins should look like.
const GUTTERS: Record<string, string> = {
  exec: "$",
  read_file: "read",
  write_file: "write",
  apply_patch: "edit",
  web_search: "search",
  web_fetch: "fetch",
  web_fetch_read: "read",
  web_fetch_grep: "search",
  remember: "save",
  update_memory: "update",
  forget_memory: "forget",
  search_memories: "search",
  spawn_subagent: "spawn",
  check_subagents: "check",
  activate_skill: "skill",
  create_skill: "skill",
  edit_skill: "skill",
  delete_skill: "skill",
  exec_output: "proc",
  exec_output_read: "proc",
  exec_output_grep: "proc",
  exec_input: "proc",
  exec_stop: "proc",
  exec_watch: "proc",
  exec_unwatch: "proc",
  exec_list: "proc",
  exec_shutdown: "proc",
  exec_upload_file: "upload",
};

/**
 * The gutter for a built-in with no hand-written verb. The friendly name is
 * already prose ("Confirm work saved", "Shut down sandbox"), so its first word
 * is the verb and the rest is the object — and because the two columns sit side
 * by side, the row reads back as the original phrase. This keeps the column
 * meaningful on every row instead of leaving a blank lane.
 */
function derivedGutter(toolName: string): { gutter: string; object: string } {
  const friendly = friendlyToolName(toolName);
  const words = friendly.split(/\s+/).filter(Boolean);
  const [first, ...rest] = words;
  if (!first || rest.length === 0) return { gutter: "call", object: friendly };
  const object = rest.join(" ");
  return { gutter: first.toLowerCase(), object: object.charAt(0).toUpperCase() + object.slice(1) };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function num(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function hostname(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

/** One-line clamp for text that lands in a subtitle rather than a block. */
function oneLine(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * A flat record renders as a field list; anything with a nested value falls
 * through to pretty-printed JSON, because a nested object flattened into a
 * single cell is less readable than the JSON it came from.
 */
function isFlat(record: Record<string, unknown>): boolean {
  return Object.values(record).every(
    (value) =>
      value === null ||
      ["string", "number", "boolean", "undefined"].includes(typeof value) ||
      (Array.isArray(value) &&
        value.every((item) => ["string", "number", "boolean"].includes(typeof item))),
  );
}

/**
 * A field value longer than this is not a field — it is a document that happens
 * to have arrived under a key (an MCP `write` carrying a whole file, say). The
 * grid has no room for it, so it is promoted to its own clamped block instead of
 * dumping thousands of characters into a table cell.
 */
export const FIELD_VALUE_MAX = 160;

function fieldText(value: unknown): string {
  if (Array.isArray(value)) return value.length === 0 ? "—" : value.join(", ");
  if (value === null || value === undefined) return "—";
  return String(value);
}

/** Short entries become the grid; long ones become blocks of their own. */
function recordBlocks(label: string, record: Record<string, unknown>): DetailBlock[] {
  if (!isFlat(record)) {
    return [{ kind: "json", label, json: JSON.stringify(record, null, 2) }];
  }
  const fields: DetailField[] = [];
  const promoted: DetailBlock[] = [];
  for (const [key, value] of Object.entries(record)) {
    const text = fieldText(value);
    if (text.length > FIELD_VALUE_MAX) {
      promoted.push({ kind: "text", label: key, text, wrap: true });
    } else {
      fields.push({ key, value: text });
    }
  }
  const blocks: DetailBlock[] = [];
  if (fields.length > 0) blocks.push({ kind: "fields", label, fields });
  blocks.push(...promoted);
  return blocks;
}

/** Render an arbitrary value as the most legible blocks we can justify. */
function valueBlocks(label: string, value: unknown): DetailBlock[] {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") {
    return value.trim() ? [{ kind: "text", label, text: value }] : [];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [{ kind: "note", text: `${label}: empty` }];
    const items = value.slice(0, LIST_PREVIEW_LIMIT).map((item) => {
      const record = asRecord(item);
      if (!record) return { primary: oneLine(String(item)) };
      const primary =
        str(record, "title") ?? str(record, "name") ?? str(record, "id") ?? oneLine(JSON.stringify(record));
      const secondary = str(record, "url") ?? str(record, "snippet") ?? str(record, "description");
      return secondary ? { primary, secondary: oneLine(secondary) } : { primary };
    });
    return [{ kind: "list", label, items, total: value.length }];
  }
  const record = asRecord(value);
  if (!record) return [{ kind: "text", label, text: String(value) }];
  if (Object.keys(record).length === 0) return [];
  return recordBlocks(label, record);
}

/**
 * The MCP wire result: `content` blocks plus optional `structuredContent` and
 * `isError`, or the legacy `{ toolResult }` compatibility shape. Text blocks
 * become text — rendering them as `[{"type":"text","text":"…"}]` shows the
 * envelope instead of the answer.
 */
function mcpResultBlocks(output: Record<string, unknown>, label: string): DetailBlock[] {
  const blocks: DetailBlock[] = [];
  const isError = output["isError"] === true;

  const content = output["content"];
  if (Array.isArray(content)) {
    const texts: string[] = [];
    const others: string[] = [];
    for (const item of content) {
      const record = asRecord(item);
      const type = str(record, "type");
      if (type === "text") {
        const text = str(record, "text");
        if (text) texts.push(text);
      } else if (type) {
        others.push(type);
      }
    }
    if (texts.length > 0) {
      blocks.push({
        kind: "text",
        label: isError ? "Failed" : label,
        text: texts.join("\n\n"),
        wrap: true,
        ...(isError ? { tone: "error" as const } : {}),
      });
    }
    if (others.length > 0) {
      blocks.push({ kind: "note", text: `Also returned ${others.join(", ")}` });
    }
  }

  const structured = asRecord(output["structuredContent"]);
  if (structured && Object.keys(structured).length > 0) {
    blocks.push(...valueBlocks(blocks.length > 0 ? "Structured" : label, structured));
  }

  if ("toolResult" in output) {
    blocks.push(...valueBlocks(label, output["toolResult"]));
  }

  if (blocks.length === 0) {
    // Not a recognizable MCP envelope — show the object itself.
    blocks.push(...valueBlocks(label, output));
  }
  return blocks;
}

/** `{ ok: false, error, detail? }` — the shared failure shape of the built-ins. */
function builtInError(output: Record<string, unknown>): { label: string; blocks: DetailBlock[] } {
  const code = str(output, "error") ?? "failed";
  const detail = str(output, "detail") ?? str(output, "message");
  const affected = output["affectedPaths"];
  const blocks: DetailBlock[] = [
    { kind: "note", text: detail ? `${code} — ${detail}` : code, tone: "error" },
  ];
  if (Array.isArray(affected) && affected.length > 0) {
    blocks.push({ kind: "note", text: `Affected: ${affected.join(", ")}` });
  }
  return { label: code, blocks };
}

function execBlocks(output: Record<string, unknown>, state: ToolRowState): DetailBlock[] {
  const blocks: DetailBlock[] = [];
  const stdout = str(output, "stdoutPreview");
  const stderr = str(output, "stderrPreview");

  if (stdout) blocks.push({ kind: "text", label: "Output", text: stdout });
  if (output["stdoutTruncated"] === true) {
    blocks.push({ kind: "note", text: "Output was truncated to a preview." });
  }
  if (stderr) {
    blocks.push({
      kind: "text",
      label: "stderr",
      text: stderr,
      ...(state === "error" ? { tone: "error" as const } : {}),
    });
  }
  if (output["stderrTruncated"] === true) {
    blocks.push({ kind: "note", text: "stderr was truncated to a preview." });
  }

  const message = str(output, "message");
  if (message) blocks.push({ kind: "note", text: message });

  if (!stdout && !stderr && !message) {
    blocks.push({ kind: "note", text: "No output." });
  }
  return blocks;
}

/** Wall-clock status for an `exec` result, whose shape carries several. */
function execStatus(output: Record<string, unknown>): { state: ToolRowState; label?: string } {
  const status = str(output, "status");
  if (status === "backgrounded") return { state: "backgrounded", label: "backgrounded" };
  if (output["timedOut"] === true) return { state: "error", label: "timed out" };
  if (status === "stopped") return { state: "error", label: "stopped" };
  const exitCode = num(output, "exitCode");
  if (status === "failed" || (exitCode !== undefined && exitCode !== 0)) {
    return { state: "error", label: exitCode === undefined ? "failed" : `exit ${exitCode}` };
  }
  return { state: "ok" };
}

export function buildToolLogEntry(
  toolName: string,
  part: ToolUIPart,
  resolved: ResolvedToolName,
): ToolLogEntry {
  const input = asRecord(part.input);
  const output = asRecord(part.output);
  const isMcp = resolved.server !== undefined;
  const isUnresolvedMcp = resolved.server === undefined && toolName.startsWith("tool_");

  // ── the gutter + object ────────────────────────────────────────────────
  const mapped = GUTTERS[toolName];
  const derived = mapped === undefined && !isMcp && !isUnresolvedMcp ? derivedGutter(toolName) : undefined;
  let gutter = mapped ?? derived?.gutter ?? "";
  let gutterKind: GutterKind =
    toolName === "exec" ? "exec" : isMcp ? "mcp" : isUnresolvedMcp ? "raw" : gutter ? "verb" : "none";
  let object = derived?.object ?? friendlyToolName(toolName);
  let objectMono = false;
  let subtitle: string | undefined;

  if (isMcp) {
    gutter = resolved.server as string;
    gutterKind = "mcp";
    object = resolved.tool;
    objectMono = true;
  } else if (isUnresolvedMcp) {
    gutter = "mcp";
    gutterKind = "raw";
    object = toolName;
    objectMono = true;
    subtitle = "Server not loaded — showing the raw key";
  }

  // ── state ──────────────────────────────────────────────────────────────
  let state: ToolRowState = "ok";
  let statusLabel: string | undefined;
  if (part.state === "output-denied") {
    state = "denied";
    statusLabel = "denied";
  } else if (part.state === "output-error") {
    state = "error";
    statusLabel = "failed";
  } else if (part.state === "input-streaming" || part.state === "input-available") {
    state = "running";
    statusLabel = "running";
  }

  const blocks: DetailBlock[] = [];

  switch (toolName) {
    case "exec": {
      const label = str(input, "label") ?? str(output, "label");
      const command = str(input, "command") ?? str(output, "command");
      if (command) {
        blocks.push({ kind: "text", label: "Command", text: command });
      }
      object = label ?? (command ? oneLineCommand(command) : undefined) ?? "a command";
      objectMono = label === undefined;
      if (label && command) subtitle = oneLineCommand(command);
      if (output && state !== "denied") {
        if (output["ok"] === false) {
          const failure = builtInError(output);
          state = "error";
          statusLabel = failure.label;
          blocks.push(...failure.blocks);
        } else {
          const status = execStatus(output);
          if (state !== "running") {
            state = status.state;
            statusLabel = status.label;
          }
          blocks.push(...execBlocks(output, state));
        }
      }
      break;
    }

    case "read_file": {
      const path = str(input, "path") ?? str(output, "path");
      object = path ?? "a file";
      objectMono = true;
      if (output?.["ok"] === false) {
        const failure = builtInError(output);
        state = "error";
        statusLabel = failure.label;
        blocks.push(...failure.blocks);
      } else if (output) {
        const start = num(output, "startLine");
        const end = num(output, "endLine");
        const content = str(output, "content");
        const range = start !== undefined && end !== undefined ? `Lines ${start}–${end}` : "Content";
        if (content) blocks.push({ kind: "text", label: range, text: content });
        if (output["truncated"] === true) {
          blocks.push({ kind: "note", text: "The file continues past this window." });
        }
      }
      break;
    }

    case "write_file": {
      const path = str(input, "path") ?? str(output, "path");
      object = path ?? "a file";
      objectMono = true;
      if (output?.["ok"] === false) {
        const failure = builtInError(output);
        state = "error";
        statusLabel = failure.label;
        blocks.push(...failure.blocks);
      } else {
        const bytes = num(output, "bytesWritten");
        if (bytes !== undefined) subtitle = `${bytes} bytes`;
        const content = str(input, "content");
        if (content) blocks.push({ kind: "text", label: "Wrote", text: content });
      }
      break;
    }

    case "apply_patch": {
      const patch = str(input, "patch");
      const summary = patch ? summarizePatch(patch) : undefined;
      const paths = summary?.paths ?? [];
      object = paths[0] ?? "a patch";
      objectMono = true;
      if (paths.length > 1) subtitle = `and ${plural(paths.length - 1, "more file")}`;
      if (output?.["ok"] === false) {
        const failure = builtInError(output);
        state = "error";
        statusLabel = failure.label;
        blocks.push(...failure.blocks);
      } else {
        if (patch) blocks.push({ kind: "diff", label: "Patch", patch });
        const written = num(output, "written");
        const deleted = num(output, "deleted");
        if (written !== undefined || deleted !== undefined) {
          const parts: string[] = [];
          if (written) parts.push(plural(written, "file") + " written");
          if (deleted) parts.push(plural(deleted, "file") + " deleted");
          if (parts.length > 0) blocks.push({ kind: "note", text: parts.join(", ") });
        }
      }
      break;
    }

    case "web_search": {
      object = str(input, "query") ?? "the web";
      const results = output?.["results"];
      if (Array.isArray(results)) {
        const hosts: string[] = [];
        for (const item of results) {
          const url = str(asRecord(item), "url");
          const host = url ? hostname(url) : undefined;
          if (host && !hosts.includes(host)) hosts.push(host);
        }
        const total = num(output, "totalAvailable") ?? results.length;
        subtitle = `${plural(total, "result")}${hosts.length > 0 ? ` · ${hosts.slice(0, 2).join(", ")}` : ""}`;
        blocks.push({
          kind: "list",
          label: "Results",
          total,
          items: results.slice(0, LIST_PREVIEW_LIMIT).map((item) => {
            const record = asRecord(item);
            const primary = str(record, "title") ?? str(record, "url") ?? "untitled";
            const url = str(record, "url");
            const host = url ? hostname(url) : undefined;
            return host ? { primary, secondary: host } : { primary };
          }),
        });
      } else if (output?.["ok"] === false) {
        const failure = builtInError(output);
        state = "error";
        statusLabel = failure.label;
        blocks.push(...failure.blocks);
      }
      break;
    }

    case "web_fetch": {
      const url = str(input, "url") ?? str(output, "url");
      object = (url ? hostname(url) : undefined) ?? url ?? "a page";
      const title = str(output, "title");
      if (title) subtitle = oneLine(title);
      if (output?.["ok"] === false) {
        const failure = builtInError(output);
        state = "error";
        statusLabel = failure.label;
        blocks.push(...failure.blocks);
      } else if (output) {
        const preview = str(output, "preview");
        if (preview) blocks.push({ kind: "text", label: "Preview", text: preview });
        if (output["truncated"] === true) {
          blocks.push({ kind: "note", text: "The page was capped before the end." });
        }
      }
      break;
    }

    case "remember":
    case "update_memory":
    case "forget_memory": {
      object = str(input, "title") ?? str(input, "key") ?? friendlyToolName(toolName);
      const content = str(input, "content");
      if (content) subtitle = oneLine(content, 90);
      // These tools answer with a plain string, not an object.
      if (typeof part.output === "string") {
        const text = part.output;
        const failed = text.startsWith("error");
        if (failed) {
          state = "error";
          statusLabel = "failed";
        }
        blocks.push({ kind: "note", text, ...(failed ? { tone: "error" as const } : {}) });
      }
      break;
    }

    case "spawn_subagent": {
      object = str(input, "label") ?? oneLine(str(input, "task") ?? "a subagent", 80);
      if (str(input, "label")) subtitle = oneLine(str(input, "task") ?? "", 90);
      if (output?.["status"] === "rejected") {
        state = "error";
        statusLabel = "rejected";
        blocks.push({ kind: "note", text: str(output, "error") ?? "rejected", tone: "error" });
      } else {
        const runId = str(output, "runId");
        if (runId) blocks.push({ kind: "fields", label: "Run", fields: [{ key: "runId", value: runId }] });
      }
      break;
    }

    case "activate_skill": {
      object =
        str(input, "name") ?? str(input, "skill") ?? str(input, "skillName") ?? "a skill";
      objectMono = true;
      break;
    }

    default: {
      // MCP and every built-in without a hand-written row: the generic path.
      if (output || part.input !== undefined) {
        if (input && Object.keys(input).length > 0) blocks.push(...valueBlocks("Sent", input));
        if (typeof part.output === "string") {
          blocks.push({ kind: "text", label: "Returned", text: part.output });
        } else if (output) {
          if (output["isError"] === true) {
            state = "error";
            statusLabel = "failed";
          }
          if (isMcp || isUnresolvedMcp || "content" in output || "structuredContent" in output) {
            blocks.push(...mcpResultBlocks(output, "Returned"));
          } else if (output["ok"] === false) {
            const failure = builtInError(output);
            state = "error";
            statusLabel = failure.label;
            blocks.push(...failure.blocks);
          } else {
            blocks.push(...valueBlocks("Returned", output));
          }
        }
      }
      break;
    }
  }

  if (state === "denied") {
    blocks.length = 0;
    blocks.push({ kind: "note", text: "You declined this call." });
  }
  if (part.state === "output-error" && part.errorText) {
    blocks.unshift({ kind: "note", text: part.errorText, tone: "error" });
  }

  return {
    gutter,
    gutterKind,
    object,
    objectMono,
    ...(subtitle ? { subtitle } : {}),
    state,
    ...(statusLabel ? { statusLabel } : {}),
    blocks,
  };
}
