import { WORKSPACE_ROOT } from "./thread-service";

const PROBE_TIMEOUT_MS = 30_000;

export type WorkspaceCleanliness =
  | { state: "clean" } // >=1 repo, all clean, nothing unpushed
  | { state: "dirty"; repos: DirtyRepo[] } // >=1 repo with changes/unpushed
  | { state: "no_repo"; hasFiles: boolean } // no git repo found
  | { state: "probe_failed"; reason: string };

export type DirtyRepo = { path: string; changes: string[]; unpushed: number };

/**
 * One line per repo: `<path>\t<porcelain status, unit-separator-joined>\t<unpushed>`.
 * With an upstream, `unpushed` is the count ahead of it. With NO upstream it is
 * the repo's OWN commit count: commits that exist only inside the sandbox are
 * work that dies with it, so a repo with commits and no remote must read as
 * dirty. (It used to emit a `NOUPSTREAM` sentinel that parsed to 0 — i.e.
 * "nothing to lose" — and such a sandbox was discarded 15 minutes after going
 * idle.) A freshly `git init`-ed repo has 0 commits and stays clean.
 * The status lines are joined with ASCII unit separator (0x1F), not a
 * printable character, since porcelain status lines carry arbitrary path
 * bytes — a delimiter drawn from that alphabet (e.g. `|`) would mis-split a
 * path containing it. `git status --porcelain` honors .gitignore, so
 * ordinary build output does not register as a change. Emits `NOREPO\tFILES`
 * / `NOREPO\tEMPTY` when no repo is found under the workspace root. The
 * literal word PROBE appears only as a marker comment so callers/tests can
 * identify this exec's command string.
 */
const PROBE_SCRIPT = `# PROBE workspace cleanliness (marker word load-bearing: unit tests stub exec by matching "PROBE" in the command string — don't remove)
set -u
root="${WORKSPACE_ROOT}"
found=0
while IFS= read -r gitdir; do
  [ -z "$gitdir" ] && continue
  found=1
  repo=$(dirname "$gitdir")
  status=$(git -C "$repo" status --porcelain 2>/dev/null | tr '\\n' '\\037')
  if git -C "$repo" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' >/dev/null 2>&1; then
    unpushed=$(git -C "$repo" rev-list --count '@{upstream}..HEAD' 2>/dev/null || echo 0)
  else
    unpushed=$(git -C "$repo" rev-list --count HEAD 2>/dev/null || echo 0)
  fi
  printf '%s\\t%s\\t%s\\n' "$repo" "$status" "$unpushed"
done <<EOF
$(find "$root" -maxdepth 4 \\( -type d -o -type f \\) -name .git 2>/dev/null)
EOF
if [ "$found" = "0" ]; then
  if [ -n "$(ls -A "$root" 2>/dev/null)" ]; then
    printf 'NOREPO\\tFILES\\n'
  else
    printf 'NOREPO\\tEMPTY\\n'
  fi
fi
`;

class UnparseableProbeLineError extends Error {}

function parseRepoLine(line: string): DirtyRepo | null {
  const parts = line.split("\t");
  if (parts.length !== 3) {
    throw new UnparseableProbeLineError(
      `expected 3 tab-separated fields, got ${parts.length}: ${JSON.stringify(line)}`,
    );
  }
  const [path, statusRaw, unpushedRaw] = parts as [string, string, string];
  if (!path) {
    throw new UnparseableProbeLineError(`empty repo path: ${JSON.stringify(line)}`);
  }

  const changes =
    statusRaw.length > 0 ? statusRaw.split("\x1f").filter((entry) => entry.length > 0) : [];

  // Always a count now — no sentinel. An unrecognized third field (including
  // the retired `NOUPSTREAM`) is unparseable, which resolves to `probe_failed`
  // and therefore preserves.
  const unpushed = Number.parseInt(unpushedRaw, 10);
  if (!Number.isFinite(unpushed) || unpushed < 0 || String(unpushed) !== unpushedRaw) {
    throw new UnparseableProbeLineError(
      `unparseable unpushed count: ${JSON.stringify(unpushedRaw)}`,
    );
  }

  if (changes.length === 0 && unpushed === 0) {
    return null;
  }
  return { path, changes, unpushed };
}

function parseNoRepoLine(line: string): boolean {
  const parts = line.split("\t");
  if (parts.length !== 2 || parts[0] !== "NOREPO") {
    throw new UnparseableProbeLineError(`unrecognized NOREPO line: ${JSON.stringify(line)}`);
  }
  if (parts[1] === "FILES") return true;
  if (parts[1] === "EMPTY") return false;
  throw new UnparseableProbeLineError(`unrecognized NOREPO marker: ${JSON.stringify(parts[1])}`);
}

function parseProbeOutput(stdout: string): WorkspaceCleanliness {
  const lines = stdout.split("\n").filter((line) => line.length > 0);

  const dirtyRepos: DirtyRepo[] = [];
  let cleanRepoCount = 0;
  let noRepoHasFiles: boolean | null = null;

  for (const line of lines) {
    if (line.startsWith("NOREPO\t")) {
      noRepoHasFiles = parseNoRepoLine(line);
      continue;
    }
    const dirty = parseRepoLine(line);
    if (dirty) {
      dirtyRepos.push(dirty);
    } else {
      cleanRepoCount += 1;
    }
  }

  const repoLineCount = dirtyRepos.length + cleanRepoCount;
  if (repoLineCount > 0) {
    if (dirtyRepos.length > 0) {
      return { state: "dirty", repos: dirtyRepos };
    }
    return { state: "clean" };
  }

  if (noRepoHasFiles !== null) {
    return { state: "no_repo", hasFiles: noRepoHasFiles };
  }

  throw new UnparseableProbeLineError("probe produced no recognizable output");
}

/**
 * Asks git, inside the sandbox, whether the workspace has any changes or
 * unpushed commits that would be lost if the sandbox were destroyed. Any
 * ambiguity — a non-zero exit, a thrown error, or output this parser cannot
 * make sense of — resolves to `probe_failed`, which callers must treat the
 * same as "dirty": never let unparseable input reach `clean`.
 */
export async function probeWorkspaceCleanliness(
  exec: (
    command: string,
    timeoutMs: number,
  ) => Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    stdoutTruncated?: boolean | undefined;
  }>,
): Promise<WorkspaceCleanliness> {
  try {
    const result = await exec(PROBE_SCRIPT, PROBE_TIMEOUT_MS);
    if (result.exitCode !== 0) {
      return {
        state: "probe_failed",
        reason: `probe exited ${result.exitCode}: ${result.stderr || result.stdout || "no output"}`,
      };
    }
    // A tail is not the output. If the cut lands mid-line the parser rejects
    // it anyway, but a cut ON a line boundary leaves output that parses
    // perfectly while the dropped head held the dirty repo — every surviving
    // line clean, verdict `clean`, sandbox destroyed. There is no way to tell
    // that apart from the real thing after the fact, so refuse before parsing.
    if (result.stdoutTruncated === true) {
      return {
        state: "probe_failed",
        reason: "probe output was truncated; the unseen head may name a dirty repository",
      };
    }
    return parseProbeOutput(result.stdout);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { state: "probe_failed", reason };
  }
}
