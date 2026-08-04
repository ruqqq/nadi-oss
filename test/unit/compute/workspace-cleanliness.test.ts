import { describe, expect, it } from "vitest";
import { probeWorkspaceCleanliness } from "../../../src/compute/workspace-cleanliness";

function fakeExec(
  script: Record<
    string,
    { exitCode?: number; stdout?: string; stderr?: string; stdoutTruncated?: boolean }
  >,
) {
  return async (command: string) => {
    for (const [needle, result] of Object.entries(script)) {
      if (command.includes(needle)) {
        return {
          exitCode: result.exitCode ?? 0,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
          stdoutTruncated: result.stdoutTruncated ?? false,
        };
      }
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

describe("probeWorkspaceCleanliness", () => {
  it("reports clean when a repo exists with no changes and nothing unpushed", async () => {
    const result = await probeWorkspaceCleanliness(
      fakeExec({ PROBE: { stdout: "/workspace/app\t\t0\n" } }),
    );
    expect(result.state).toBe("clean");
  });

  it("reports dirty when any repo has changes", async () => {
    const result = await probeWorkspaceCleanliness(
      fakeExec({ PROBE: { stdout: "/workspace/app\t M src/a.ts\t0\n" } }),
    );
    expect(result.state).toBe("dirty");
    expect(result.state === "dirty" && result.repos[0]?.path).toBe("/workspace/app");
  });

  it("reports dirty when a repo has unpushed commits", async () => {
    const result = await probeWorkspaceCleanliness(
      fakeExec({ PROBE: { stdout: "/workspace/app\t\t3\n" } }),
    );
    expect(result.state).toBe("dirty");
    expect(result.state === "dirty" && result.repos[0]?.unpushed).toBe(3);
  });

  it("is dirty when ONE of several repos is dirty", async () => {
    const result = await probeWorkspaceCleanliness(
      fakeExec({
        PROBE: { stdout: "/workspace/a\t\t0\n/workspace/b\t M x\t0\n/workspace/c\t\t0\n" },
      }),
    );
    expect(result.state).toBe("dirty");
    expect(result.state === "dirty" && result.repos).toHaveLength(1);
  });

  it("reports no_repo with hasFiles when files exist outside version control", async () => {
    const result = await probeWorkspaceCleanliness(
      fakeExec({ PROBE: { stdout: "NOREPO\tFILES\n" } }),
    );
    expect(result).toEqual({ state: "no_repo", hasFiles: true });
  });

  it("reports no_repo without files for an untouched workspace", async () => {
    const result = await probeWorkspaceCleanliness(
      fakeExec({ PROBE: { stdout: "NOREPO\tEMPTY\n" } }),
    );
    expect(result).toEqual({ state: "no_repo", hasFiles: false });
  });

  it("reports probe_failed on a non-zero exit", async () => {
    const result = await probeWorkspaceCleanliness(
      fakeExec({ PROBE: { exitCode: 127, stderr: "git: not found" } }),
    );
    expect(result.state).toBe("probe_failed");
  });

  it("reports probe_failed when exec throws", async () => {
    const result = await probeWorkspaceCleanliness(async () => {
      throw new Error("runtime unreachable");
    });
    expect(result.state).toBe("probe_failed");
  });

  it("reports dirty for a linked worktree discovered via a .git file", async () => {
    // git worktree add creates a .git FILE (gitdir: .../worktrees/name), not a
    // dir; the probe's `find` predicate must match both so linked worktrees
    // are not invisible to cleanliness checks. This pins parsing of a line
    // for such a repo path — the discovery predicate itself is in the shell
    // string and is not exercised by this stub-based test.
    const result = await probeWorkspaceCleanliness(
      fakeExec({ PROBE: { stdout: "/workspace/wt/feature-branch\t M src/a.ts\t0\n" } }),
    );
    expect(result.state).toBe("dirty");
    expect(result.state === "dirty" && result.repos[0]?.path).toBe("/workspace/wt/feature-branch");
  });

  /**
   * The parser sees only a number, so "no upstream, 2 local-only commits" and
   * "2 commits ahead of an upstream" are the SAME input to it — a matrix here
   * that names both is the same test twice, and it is exactly what failed to
   * catch a script that counted the whole history. The repo-shape matrix lives
   * where the distinction is decided, in
   * `workspace-cleanliness-script.test.ts`, which runs the real script against
   * real repos. What is left for the parser is the count → verdict mapping.
   */
  it("maps a non-zero count to dirty and zero to clean", async () => {
    expect(
      (await probeWorkspaceCleanliness(fakeExec({ PROBE: { stdout: "/workspace/app\t\t2\n" } })))
        .state,
    ).toBe("dirty");
    expect(
      (await probeWorkspaceCleanliness(fakeExec({ PROBE: { stdout: "/workspace/app\t\t0\n" } })))
        .state,
    ).toBe("clean");
  });

  it("asks git only for commits no remote already has, when there is no upstream", async () => {
    // A bare `rev-list --count HEAD` counts the WHOLE history of any branch
    // without an upstream — the normal shape of a coding thread between
    // `checkout -b` and its first `push -u`.
    let command = "";
    await probeWorkspaceCleanliness(async (script) => {
      command = script;
      return { exitCode: 0, stdout: "/workspace/app\t\t0\n", stderr: "" };
    });
    expect(command).toContain("rev-list --count HEAD --not --remotes");
    expect(command).not.toContain("NOUPSTREAM");
  });

  it("reports probe_failed on the retired NOUPSTREAM sentinel rather than clean", async () => {
    // A sandbox running an older probe (or any third field that is not a
    // count) must preserve, not be read as "nothing to lose".
    const result = await probeWorkspaceCleanliness(
      fakeExec({ PROBE: { stdout: "/workspace/app\t\tNOUPSTREAM\n" } }),
    );
    expect(result.state).toBe("probe_failed");
  });

  /**
   * DATA LOSS GUARD. `execRun`'s start-and-poll fallback returns a TAIL
   * (200 lines / 32KB), and a cut on a line boundary produces output that
   * parses perfectly. Here the dropped head named the dirty repo and every
   * surviving line is clean — parsing it would answer `clean` and the sandbox
   * would be DESTROYED. The truncation flag is the only thing that can tell
   * this apart from genuinely-clean output.
   */
  it("reports probe_failed when stdout was truncated on a line boundary, even though every visible line is clean", async () => {
    const result = await probeWorkspaceCleanliness(
      fakeExec({
        PROBE: {
          // The dirty repo was in the dropped head; this is the surviving tail.
          stdout: "/workspace/b\t\t0\n/workspace/c\t\t0\n",
          stdoutTruncated: true,
        },
      }),
    );
    expect(result.state).toBe("probe_failed");
  });

  it("treats an untruncated tail normally", async () => {
    const result = await probeWorkspaceCleanliness(
      fakeExec({ PROBE: { stdout: "/workspace/b\t\t0\n", stdoutTruncated: false } }),
    );
    expect(result.state).toBe("clean");
  });

  /**
   * SAFETY FALLTHROUGH. Exit 0 with nothing the parser recognizes must never
   * resolve to `clean` — that would destroy a sandbox the probe told us
   * nothing about. It must land on `probe_failed`, which preserves.
   */
  it("reports probe_failed when stdout is empty despite a zero exit", async () => {
    const result = await probeWorkspaceCleanliness(fakeExec({ PROBE: { stdout: "" } }));
    expect(result.state).toBe("probe_failed");
  });

  it("reports probe_failed when stdout is whitespace-only", async () => {
    const result = await probeWorkspaceCleanliness(fakeExec({ PROBE: { stdout: "   \n\t\n  " } }));
    expect(result.state).toBe("probe_failed");
  });

  it("does not mis-split a status entry naming a path with a literal pipe", async () => {
    // The join/split delimiter is the unit separator (0x1F), not "|", so a
    // path containing a literal pipe character stays one entry.
    const result = await probeWorkspaceCleanliness(
      fakeExec({ PROBE: { stdout: "/workspace/app\t M weird|name.ts\x1f?? other.ts\t0\n" } }),
    );
    expect(result.state).toBe("dirty");
    expect(result.state === "dirty" && result.repos[0]?.changes).toEqual([
      " M weird|name.ts",
      "?? other.ts",
    ]);
  });

  it("reports probe_failed when stdout contains only unrecognizable lines", async () => {
    const result = await probeWorkspaceCleanliness(
      fakeExec({ PROBE: { stdout: "not a probe line at all\n" } }),
    );
    expect(result.state).toBe("probe_failed");
  });
});
