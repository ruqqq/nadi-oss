import { ComputeError } from "../errors";
import { normalizeWorkspacePath } from "./path";
import { WORKSPACE_ROOT } from "../workspace-layout";

/**
 * One line inside a hunk, tagged by how it participates in matching:
 * `context` and `remove` lines must match the file exactly before a hunk can
 * apply; `context` and `add` lines make up the replacement text.
 */
export type PatchHunkLine =
  | { kind: "context"; text: string }
  | { kind: "remove"; text: string }
  | { kind: "add"; text: string };

export type PatchHunk = {
  lines: PatchHunkLine[];
};

export type PatchOperation =
  | { kind: "add"; path: string; content: string }
  | { kind: "update"; path: string; moveTo?: string; hunks: PatchHunk[] }
  | { kind: "delete"; path: string };

export type PatchResult = {
  writes: Map<string, string>;
  deletes: Set<string>;
};

const ADD_RE = /^\*\*\* Add File: (.+)$/;
const DELETE_RE = /^\*\*\* Delete File: (.+)$/;
const UPDATE_RE = /^\*\*\* Update File: (.+)$/;
const MOVE_RE = /^\*\*\* Move to: (.+)$/;

type BuildingAdd = { kind: "add"; path: string; contentLines: string[] };
type BuildingUpdate = {
  kind: "update";
  path: string;
  moveTo?: string;
  hunks: PatchHunkLine[][];
};

/**
 * Parses the `*** Begin Patch` / `*** End Patch` model patch grammar into
 * explicit operations. Pure and synchronous: it does not touch the filesystem.
 * Operation paths keep their raw patch spelling (the file service resolves them
 * against a live backend before any write), but duplicate detection compares
 * canonical `/workspace/...` forms so aliased spellings of one file cannot slip
 * through — which also rejects absolute/traversal paths at parse time.
 */
export function parsePatch(text: string): PatchOperation[] {
  const lines = text.split(/\r?\n/);

  const beginCount = lines.filter((line) => line === "*** Begin Patch").length;
  const endCount = lines.filter((line) => line === "*** End Patch").length;
  if (beginCount !== 1 || endCount !== 1) {
    throw new ComputeError("compute_patch_malformed");
  }
  const beginIndex = lines.indexOf("*** Begin Patch");
  const endIndex = lines.indexOf("*** End Patch");
  if (endIndex <= beginIndex) {
    throw new ComputeError("compute_patch_malformed");
  }

  const body = lines.slice(beginIndex + 1, endIndex);
  const operations: PatchOperation[] = [];
  let current: BuildingAdd | BuildingUpdate | null = null;

  const flush = (): void => {
    if (!current) return;
    if (current.kind === "add") {
      const content = current.contentLines.length > 0 ? `${current.contentLines.join("\n")}\n` : "";
      operations.push({ kind: "add", path: current.path, content });
    } else {
      const hunks: PatchHunk[] = current.hunks.map((hunkLines) => {
        const matcherCount = hunkLines.filter((line) => line.kind !== "add").length;
        if (matcherCount === 0) {
          // A hunk needs at least one context/remove line to anchor it; a
          // pure-insertion hunk has no unambiguous location to apply at.
          throw new ComputeError("compute_patch_malformed");
        }
        return { lines: hunkLines };
      });
      operations.push({
        kind: "update",
        path: current.path,
        ...(current.moveTo !== undefined ? { moveTo: current.moveTo } : {}),
        hunks,
      });
    }
    current = null;
  };

  for (const line of body) {
    const addMatch = ADD_RE.exec(line);
    if (addMatch) {
      flush();
      current = { kind: "add", path: addMatch[1] as string, contentLines: [] };
      continue;
    }

    const deleteMatch = DELETE_RE.exec(line);
    if (deleteMatch) {
      flush();
      operations.push({ kind: "delete", path: deleteMatch[1] as string });
      continue;
    }

    const updateMatch = UPDATE_RE.exec(line);
    if (updateMatch) {
      flush();
      current = { kind: "update", path: updateMatch[1] as string, hunks: [] };
      continue;
    }

    const moveMatch = MOVE_RE.exec(line);
    if (moveMatch) {
      if (!current || current.kind !== "update" || current.moveTo !== undefined) {
        throw new ComputeError("compute_patch_malformed");
      }
      current.moveTo = moveMatch[1] as string;
      continue;
    }

    if (line.startsWith("@@")) {
      if (!current || current.kind !== "update") {
        throw new ComputeError("compute_patch_malformed");
      }
      current.hunks.push([]);
      continue;
    }

    if (line === "") {
      // A blank context line should be a single space (" "), which slices to
      // "" anyway. Editors/terminals often strip trailing whitespace, so a
      // bare "" arrives here too; inside an update hunk, treat it the same
      // way. Outside a hunk (or between operations) "" stays an ignorable
      // separator.
      if (current && current.kind === "update" && current.hunks.length > 0) {
        const hunk = current.hunks.at(-1);
        if (!hunk) {
          throw new ComputeError("compute_patch_malformed");
        }
        hunk.push({ kind: "context", text: "" });
        continue;
      }
      if (current) {
        throw new ComputeError("compute_patch_malformed");
      }
      continue;
    }

    if (line.startsWith("*** ")) {
      throw new ComputeError("compute_patch_malformed");
    }

    if (!current) {
      throw new ComputeError("compute_patch_malformed");
    }

    if (current.kind === "add") {
      if (!line.startsWith("+")) {
        throw new ComputeError("compute_patch_malformed");
      }
      current.contentLines.push(line.slice(1));
      continue;
    }

    const hunk = current.hunks.at(-1);
    if (!hunk) {
      throw new ComputeError("compute_patch_malformed");
    }
    if (line.startsWith(" ")) {
      hunk.push({ kind: "context", text: line.slice(1) });
    } else if (line.startsWith("-")) {
      hunk.push({ kind: "remove", text: line.slice(1) });
    } else if (line.startsWith("+")) {
      hunk.push({ kind: "add", text: line.slice(1) });
    } else {
      throw new ComputeError("compute_patch_malformed");
    }
  }
  flush();

  assertNoDuplicatePaths(operations);
  return operations;
}

/**
 * Rejects a path used as more than one operation's source, a path used as
 * more than one operation's destination (an add/create target, or an
 * update's final path after an optional move), and a destination that
 * collides with a path the patch deletes — a `delete` operation's path, or a
 * moved update's source path (a move implicitly deletes its source). Task
 * 3 commits writes before deletes, so writing into a path that also gets
 * deleted would silently destroy the write.
 */
function assertNoDuplicatePaths(operations: PatchOperation[]): void {
  // ROOT-INDEPENDENT on purpose. This normalizes only to COMPARE two spellings
  // of one relative path, so any single consistent root gives the same verdict;
  // `WORKSPACE_ROOT` is the arbitrary one. It deliberately does not take the
  // caller's per-thread root — `parsePatch` is a pure parse with no thread in
  // scope, and threading one through would imply a per-thread answer this check
  // does not have.
  //
  // Compare canonical rooted forms, not raw patch spellings. The file
  // service keys every operation on the same normalization, so
  // "src/a.ts", "./src/a.ts", "src//a.ts", and "src/./a.ts" all name one file
  // on disk. Deduping on raw text would let two spellings slip through as
  // distinct — a write and a delete of the same file — and the commit's
  // write-then-delete would silently destroy it. The dedup key MUST match the
  // execution key. `normalizeWorkspacePath` also rejects absolute/traversal
  // paths here, at parse time, with the same `compute_invalid_path` the service
  // would otherwise raise.
  const deletedPaths = new Set<string>();
  for (const op of operations) {
    if (op.kind === "delete") {
      deletedPaths.add(normalizeWorkspacePath(op.path, WORKSPACE_ROOT));
    } else if (op.kind === "update" && op.moveTo !== undefined) {
      deletedPaths.add(normalizeWorkspacePath(op.path, WORKSPACE_ROOT));
    }
  }

  const sources = new Set<string>();
  const destinations = new Set<string>();

  for (const op of operations) {
    const source = normalizeWorkspacePath(op.path, WORKSPACE_ROOT);
    if (sources.has(source)) {
      throw new ComputeError("compute_patch_duplicate_path");
    }
    sources.add(source);

    if (op.kind === "delete") continue;
    const destination =
      op.kind === "update" && op.moveTo !== undefined
        ? normalizeWorkspacePath(op.moveTo, WORKSPACE_ROOT)
        : source;
    if (destinations.has(destination) || deletedPaths.has(destination)) {
      throw new ComputeError("compute_patch_duplicate_path");
    }
    destinations.add(destination);
  }
}

/**
 * Applies parsed operations against an in-memory snapshot of file contents,
 * producing the writes and deletes the caller must perform. Hunks apply in
 * source order using exact context matching only — no fuzzy or best-effort
 * matching.
 */
export function applyPatchToFiles(
  operations: PatchOperation[],
  files: Map<string, string>,
): PatchResult {
  const writes = new Map<string, string>();
  const deletes = new Set<string>();

  for (const op of operations) {
    if (op.kind === "add") {
      if (files.has(op.path)) {
        throw new ComputeError("compute_patch_file_exists");
      }
      writes.set(op.path, op.content);
      continue;
    }

    if (op.kind === "delete") {
      if (!files.has(op.path)) {
        throw new ComputeError("compute_patch_missing_file");
      }
      deletes.add(op.path);
      continue;
    }

    const original = files.get(op.path);
    if (original === undefined) {
      throw new ComputeError("compute_patch_missing_file");
    }
    const updated = applyHunks(original, op.hunks);
    const destination = op.moveTo ?? op.path;
    writes.set(destination, updated);
    if (op.moveTo !== undefined) {
      deletes.add(op.path);
    }
  }

  return { writes, deletes };
}

/**
 * Applies hunks to a single file's text in source order. Each hunk's
 * context+remove lines must match a contiguous, non-overlapping run of the
 * original lines at or after the previous hunk's end; a match found only
 * earlier in the file (i.e. inside a range an earlier hunk already
 * consumed) is an overlap, not a plain mismatch.
 */
function applyHunks(original: string, hunks: PatchHunk[]): string {
  const lines = original.split("\n");
  let cursor = 0;
  const output: string[] = [];

  for (const hunk of hunks) {
    const matcher = hunk.lines.filter((line) => line.kind !== "add").map((line) => line.text);
    const replacement = hunk.lines
      .filter((line) => line.kind !== "remove")
      .map((line) => line.text);

    const index = indexOfSubsequence(lines, matcher, cursor);
    if (index === -1) {
      const earlier = indexOfSubsequence(lines, matcher, 0);
      if (earlier !== -1 && earlier < cursor) {
        throw new ComputeError("compute_patch_hunk_overlap");
      }
      throw new ComputeError("compute_patch_hunk_mismatch");
    }

    output.push(...lines.slice(cursor, index), ...replacement);
    cursor = index + matcher.length;
  }

  output.push(...lines.slice(cursor));
  return output.join("\n");
}

function indexOfSubsequence(haystack: string[], needle: string[], from: number): number {
  for (let i = from; i <= haystack.length - needle.length; i++) {
    let matched = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return i;
  }
  return -1;
}
