import type { ToolUIPart } from "ai";

/**
 * Builds the ambient, verb-led one-liner for a tool run — "Edited next.config.ts
 * +12 −3", "Ran pnpm test", or a grouped "Ran 3 commands, read 2 files, edited a
 * file +19 −0". Success is silent (no status glyph); the renderer adds a hanging
 * warning only on error and a spinner only while active. This module is pure and
 * unit-tested; ToolGroup/CompletionGroup render its segments.
 */

/** Semantic tone for a segment; the renderer maps these to Dispatch tokens. */
export type LineTone = "add" | "del" | "faint";

export interface LineSegment {
  text: string;
  tone?: LineTone;
  /** Render in the mono face (paths, commands, counts). */
  mono?: boolean;
}

export interface ToolLine {
  segments: LineSegment[];
}

interface Verb {
  /** Past-tense verb, capitalized (lowercased for non-leading clauses). */
  past: string;
  noun: string;
  nounPlural: string;
  /** Uncountable object (e.g. "the web") — never gets an article or count noun. */
  uncountable?: boolean;
}

// The verb + object noun for each tool. Common/important tools get real verbs;
// anything absent falls back to the generic "Ran N tools" phrasing.
const VERBS: Record<string, Verb> = {
  exec: { past: "Ran", noun: "command", nounPlural: "commands" },
  read_file: { past: "Read", noun: "file", nounPlural: "files" },
  write_file: { past: "Wrote", noun: "file", nounPlural: "files" },
  apply_patch: { past: "Edited", noun: "file", nounPlural: "files" },
  web_search: { past: "Searched", noun: "the web", nounPlural: "the web", uncountable: true },
  web_fetch: { past: "Fetched", noun: "page", nounPlural: "pages" },
  web_fetch_read: { past: "Read", noun: "fetched page", nounPlural: "fetched pages" },
  web_fetch_grep: { past: "Searched", noun: "fetched page", nounPlural: "fetched pages" },
  remember: { past: "Saved", noun: "memory", nounPlural: "memories" },
  update_memory: { past: "Updated", noun: "memory", nounPlural: "memories" },
  forget_memory: { past: "Forgot", noun: "memory", nounPlural: "memories" },
  search_memories: { past: "Searched", noun: "memory", nounPlural: "memories", uncountable: true },
  spawn_subagent: { past: "Started", noun: "subagent", nounPlural: "subagents" },
  stop_subagent: { past: "Stopped", noun: "subagent", nounPlural: "subagents" },
  activate_skill: { past: "Used", noun: "skill", nounPlural: "skills" },
};

const GENERIC: Verb = { past: "Ran", noun: "tool", nounPlural: "tools" };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.at(-1) ?? path;
}

function article(noun: string): string {
  return /^[aeiou]/i.test(noun) ? "an" : "a";
}

/**
 * Counts added/removed lines and collects touched paths from the `*** Begin
 * Patch` grammar. Forgiving — a display estimate, not the authoritative parser
 * (that lives server-side in src/compute/files/patch.ts).
 */
export function summarizePatch(patch: string): { paths: string[]; added: number; removed: number } {
  const paths: string[] = [];
  let added = 0;
  let removed = 0;
  for (const line of patch.split(/\r?\n/)) {
    const header = /^\*\*\* (?:Add|Delete|Update) File: (.+)$/.exec(line);
    if (header) {
      paths.push(header[1] as string);
      continue;
    }
    if (line.startsWith("*** ") || line.startsWith("@@")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { paths, added, removed };
}

function diffSegments(added: number, removed: number): LineSegment[] {
  const segments: LineSegment[] = [];
  if (added > 0) segments.push({ text: `+${added}`, tone: "add" });
  if (removed > 0) segments.push({ text: `−${removed}`, tone: "del" });
  return segments;
}

/** The mono object noun for a single tool (a filename, a command, a host). */
function toolObject(toolName: string, part: ToolUIPart): string | undefined {
  const input = asRecord(part.input);
  const output = asRecord(part.output);
  if (toolName === "exec") {
    return clean(stringField(input, "command") ?? stringField(input, "label"));
  }
  if (toolName === "read_file" || toolName === "write_file") {
    const path = clean(stringField(input, "path") ?? stringField(output, "path"));
    return path ? basename(path) : undefined;
  }
  if (toolName === "web_fetch") {
    const url = clean(stringField(input, "url") ?? stringField(output, "url"));
    if (!url) return undefined;
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return undefined;
    }
  }
  if (toolName === "activate_skill") {
    return clean(
      stringField(input, "name") ??
        stringField(input, "skill") ??
        stringField(input, "skillName") ??
        stringField(output, "skill"),
    );
  }
  return undefined;
}

/** An optional faint suffix for a single tool (search sources, a subagent task). */
function toolTail(toolName: string, part: ToolUIPart): string | undefined {
  const input = asRecord(part.input);
  const output = asRecord(part.output);
  if (toolName === "web_search") {
    const results = output?.["results"];
    if (Array.isArray(results)) {
      const hosts: string[] = [];
      for (const r of results) {
        const url = stringField(asRecord(r), "url");
        if (!url) continue;
        try {
          const host = new URL(url).hostname.replace(/^www\./, "");
          if (!hosts.includes(host)) hosts.push(host);
        } catch {
          // Skip an unparseable URL rather than break the line.
        }
      }
      if (hosts.length > 0) {
        const shown = hosts.slice(0, 2);
        const extra = hosts.length - shown.length;
        return shown.join(", ") + (extra > 0 ? ` +${extra}` : "");
      }
    }
    return clean(stringField(input, "query"));
  }
  if (toolName === "spawn_subagent") {
    return clean(stringField(input, "task"));
  }
  if (toolName === "remember" || toolName === "update_memory" || toolName === "forget_memory") {
    return clean(stringField(input, "title") ?? stringField(input, "key"));
  }
  return undefined;
}

/**
 * The single-tool line: a verb-led phrase plus a mono object, an inline diff
 * stat (patches), and a faint tail (search sources, subagent task). Falls back
 * to `fallbackLabel` (the resolved friendly name) for tools without a verb —
 * chiefly MCP tools — so nothing renders as a bare "Ran a tool".
 */
export function getSingleToolLine(
  toolName: string,
  part: ToolUIPart,
  fallbackLabel: string,
): ToolLine {
  const verb = VERBS[toolName];
  if (!verb) return { segments: [{ text: fallbackLabel }] };

  const segments: LineSegment[] = [];
  const object = toolObject(toolName, part);
  if (verb.uncountable) {
    segments.push({ text: `${verb.past} ${verb.noun}` });
  } else if (object) {
    segments.push({ text: verb.past }, { text: object, mono: true });
  } else {
    segments.push({ text: `${verb.past} ${article(verb.noun)} ${verb.noun}` });
  }

  if (toolName === "apply_patch") {
    const patch = stringField(asRecord(part.input), "patch");
    if (patch) {
      const { paths, added, removed } = summarizePatch(patch);
      // A single named file reads better as the object than "a file".
      if (paths.length === 1 && !object) {
        segments[segments.length - 1] = { text: verb.past };
        segments.push({ text: basename(paths[0] as string), mono: true });
      } else if (paths.length > 1) {
        segments[segments.length - 1] = { text: `${verb.past} ${paths.length} files` };
      }
      segments.push(...diffSegments(added, removed));
    }
  }

  const tail = toolTail(toolName, part);
  if (tail) segments.push({ text: `· ${tail}`, tone: "faint" });

  return { segments };
}

/**
 * The grouped-run line: consecutive tools summarized by verb with counts —
 * "Ran 3 commands, read 2 files, edited a file" — plus the summed diff stat.
 */
export function getRunToolLine(entries: { toolName: string; part: ToolUIPart }[]): ToolLine {
  interface Bucket extends Verb {
    key: string;
    count: number;
  }
  const buckets: Bucket[] = [];
  let added = 0;
  let removed = 0;

  for (const entry of entries) {
    const verb = VERBS[entry.toolName] ?? GENERIC;
    if (entry.toolName === "apply_patch") {
      const patch = stringField(asRecord(entry.part.input), "patch");
      if (patch) {
        const stat = summarizePatch(patch);
        added += stat.added;
        removed += stat.removed;
      }
    }
    const key = `${verb.past}|${verb.noun}`;
    const existing = buckets.find((b) => b.key === key);
    if (existing) existing.count += 1;
    else buckets.push({ ...verb, key, count: 1 });
  }

  const clauses = buckets.map((b, i) => {
    const verb = i === 0 ? b.past : b.past.toLowerCase();
    let object: string;
    if (b.uncountable) {
      object = b.count === 1 ? b.noun : `${b.noun} ×${b.count}`;
    } else if (b.count === 1) {
      object = `${article(b.noun)} ${b.noun}`;
    } else {
      object = `${b.count} ${b.nounPlural}`;
    }
    return `${verb} ${object}`;
  });

  const segments: LineSegment[] = [{ text: clauses.join(", ") }];
  segments.push(...diffSegments(added, removed));
  return { segments };
}
