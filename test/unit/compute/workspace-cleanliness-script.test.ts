import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PROBE_SCRIPT,
  probeWorkspaceCleanliness,
} from "../../../src/compute/workspace-cleanliness";
import { threadWorktreeBranch } from "../../../src/compute/workspace-layout";

/**
 * The probe's verdict is decided in the shell, and the parser cannot see it: a
 * repo with three commits already on origin and a repo with three commits that
 * exist only in the sandbox send the SAME line if the script counts wrong.
 * These tests therefore run the real `PROBE_SCRIPT` against real git repos.
 *
 * Per `nadi-live-shell-test-eval-template` the script is used verbatim — only
 * its workspace root is repointed at a temp dir, and that substitution is
 * asserted so a rename cannot silently turn these into no-ops.
 *
 * Their absence is why `rev-list --count HEAD` shipped: it counts the WHOLE
 * history whenever the branch has no upstream, which is exactly the shape of a
 * coding thread between `checkout -b` and its first `push -u`.
 */

const GIT_ID = [
  "-c",
  "user.email=probe@test.invalid",
  "-c",
  "user.name=probe",
  "-c",
  "commit.gpgsign=false",
];

function sh(script: string, cwd: string): void {
  const result = spawnSync("/bin/sh", ["-c", script], { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`fixture setup failed (${result.status}): ${script}\n${result.stderr}`);
  }
}

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", [...GIT_ID, ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.status}): ${result.stderr}`);
  }
}

/** A workspace root holding exactly one repo, built by `build`. */
function workspace(build: (root: string, origin: string) => void): string {
  const base = mkdtempSync(join(tmpdir(), "nadi-probe-"));
  const root = join(base, "workspace");
  const origin = join(base, "origin.git");
  sh(`mkdir -p "${root}"`, base);
  build(root, origin);
  return root;
}

/** A bare origin with three commits — the history a clone brings with it. */
function seedOrigin(root: string, origin: string): void {
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  const seed = join(root, "..", "seed");
  sh(`mkdir -p "${seed}"`, root);
  git(seed, "init", "-q", "-b", "main");
  for (const n of [1, 2, 3]) {
    sh(`echo ${n} > f${n}.txt`, seed);
    git(seed, "add", "-A");
    git(seed, "commit", "-qm", `c${n}`);
  }
  git(seed, "push", "-q", origin, "main:main");
}

function rootedScript(root: string): string {
  const rooted = PROBE_SCRIPT.replace('root="/workspace"', `root="${root}"`);
  // If the root line is ever reformatted this substitution stops applying and
  // every test here would probe a nonexistent /workspace and pass as EMPTY.
  expect(rooted).not.toBe(PROBE_SCRIPT);
  return rooted;
}

/**
 * Runs the real probe end to end: `probeWorkspaceCleanliness` builds the
 * command, the exec asserts it is byte-for-byte what production sends, and only
 * the workspace root is repointed before /bin/sh (dash, as in the sandbox) runs
 * it against the fixture.
 */
function runProbe(root: string) {
  return probeWorkspaceCleanliness(async (command) => {
    expect(command).toBe(PROBE_SCRIPT);
    const result = spawnSync("/bin/sh", ["-c", rootedScript(root)], { encoding: "utf8" });
    return {
      exitCode: result.status ?? 1,
      stdout: result.stdout,
      stderr: result.stderr,
      stdoutTruncated: false,
    };
  });
}

/** The third field of the single repo line the script emitted. */
function unpushedField(root: string): string {
  const out = spawnSync("/bin/sh", ["-c", rootedScript(root)], { encoding: "utf8" }).stdout.trim();
  const parts = out.split("\t");
  expect(parts).toHaveLength(3);
  return parts[2] as string;
}

const cases: Array<{
  name: string;
  unpushed: string;
  state: "clean" | "dirty";
  build: (root: string, origin: string) => void;
}> = [
  {
    name: "git init with an unborn HEAD",
    unpushed: "0",
    state: "clean",
    build: (root) => git(root, "init", "-q", "-b", "main", join(root, "repo")),
  },
  {
    name: "no remote, one local commit",
    unpushed: "1",
    state: "dirty",
    build: (root) => {
      const repo = join(root, "repo");
      git(root, "init", "-q", "-b", "main", repo);
      sh("echo hi > f.txt", repo);
      git(repo, "add", "-A");
      git(repo, "commit", "-qm", "only-here");
    },
  },
  {
    name: "clone on its tracking branch, fully pushed",
    unpushed: "0",
    state: "clean",
    build: (root, origin) => {
      seedOrigin(root, origin);
      git(root, "clone", "-q", origin, join(root, "repo"));
    },
  },
  {
    // THE REGRESSION. No upstream, but every commit is already on origin.
    name: "clone plus checkout -b, no local commits",
    unpushed: "0",
    state: "clean",
    build: (root, origin) => {
      seedOrigin(root, origin);
      const repo = join(root, "repo");
      git(root, "clone", "-q", origin, repo);
      git(repo, "checkout", "-qb", "feature");
    },
  },
  {
    name: "clone plus checkout -b with one local commit",
    unpushed: "1",
    state: "dirty",
    build: (root, origin) => {
      seedOrigin(root, origin);
      const repo = join(root, "repo");
      git(root, "clone", "-q", origin, repo);
      git(repo, "checkout", "-qb", "feature");
      sh("echo work > new.txt", repo);
      git(repo, "add", "-A");
      git(repo, "commit", "-qm", "local-work");
    },
  },
  {
    name: "clone with a detached HEAD",
    unpushed: "0",
    state: "clean",
    build: (root, origin) => {
      seedOrigin(root, origin);
      const repo = join(root, "repo");
      git(root, "clone", "-q", origin, repo);
      git(repo, "checkout", "-q", "--detach", "HEAD");
    },
  },
];

describe("PROBE_SCRIPT against real git repositories", () => {
  for (const { name, unpushed, state, build } of cases) {
    it(`reports ${unpushed} unpushed and ${state} for ${name}`, async () => {
      const root = workspace(build);
      expect(unpushedField(root)).toBe(unpushed);
      expect((await runProbe(root)).state).toBe(state);
    });
  }

  it("reports no_repo with files for unversioned work, and EMPTY for nothing", async () => {
    const withFiles = workspace((root) => sh("echo notes > notes.md", root));
    expect(await runProbe(withFiles)).toEqual({ state: "no_repo", hasFiles: true });
    const empty = workspace(() => undefined);
    expect(await runProbe(empty)).toEqual({ state: "no_repo", hasFiles: false });
  });

  it("reports dirty for uncommitted changes in an otherwise pushed clone", async () => {
    const root = workspace((r, origin) => {
      seedOrigin(r, origin);
      const repo = join(r, "repo");
      git(r, "clone", "-q", origin, repo);
      sh("echo edited >> f1.txt", repo);
    });
    const result = await runProbe(root);
    expect(result.state).toBe("dirty");
    expect(result.state === "dirty" && result.repos[0]?.changes).toEqual([" M f1.txt"]);
  });
});

/**
 * The P3 layout, against a REAL git: one clone for the agent under `repos/`,
 * one `git worktree` per thread under `threads/<threadId>/`, each on its own
 * branch. Two things here can only be proved against git itself.
 *
 * 1. `worktree add` REFUSES a branch that is already checked out in another
 *    worktree. That is the whole reason `repository-preparation` creates
 *    `nadi/thread-<id>` per thread instead of checking out the default branch:
 *    a mocked exec would happily accept either.
 * 2. The probe has to FIND those worktrees. A thread's `.git` now sits at
 *    `<root>/threads/<threadId>/<name>/.git` — one level deeper than the old
 *    layout — and a `find -maxdepth` that stops short reports `no_repo`, the
 *    "nothing to lose" verdict that lets an idle box holding uncommitted work
 *    be discarded. Nothing else in the system would notice.
 */
describe("PROBE_SCRIPT against the P3 per-thread worktree layout", () => {
  const THREAD_A = "thr_00000000-0000-4000-8000-00000000000a";
  const THREAD_B = "thr_00000000-0000-4000-8000-00000000000b";

  /** `repos/nadi` cloned from origin, plus a worktree per listed thread. */
  function layout(threadIds: string[]) {
    return workspace((root, origin) => {
      seedOrigin(root, origin);
      const clone = join(root, "repos", "nadi");
      sh(`mkdir -p "${join(root, "repos")}"`, root);
      git(root, "clone", "-q", origin, clone);
      for (const threadId of threadIds) {
        const worktree = join(root, "threads", threadId, "nadi");
        git(
          clone,
          "worktree",
          "add",
          "-q",
          "-b",
          threadWorktreeBranch(threadId),
          worktree,
          "origin/main",
        );
      }
    });
  }

  it("gives two threads their own worktrees off one clone", async () => {
    const root = layout([THREAD_A, THREAD_B]);

    const worktreeA = join(root, "threads", THREAD_A, "nadi");
    const worktreeB = join(root, "threads", THREAD_B, "nadi");
    const branchOf = (cwd: string) =>
      spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd,
        encoding: "utf8",
      }).stdout.trim();

    // Its own branch each, and neither is detached.
    expect(branchOf(worktreeA)).toBe(threadWorktreeBranch(THREAD_A));
    expect(branchOf(worktreeB)).toBe(threadWorktreeBranch(THREAD_B));
    expect(branchOf(worktreeA)).not.toBe("HEAD");

    // Clean out of the box: three commits, all already on origin.
    expect((await runProbe(root)).state).toBe("clean");
  });

  /**
   * The mutation this whole design exists to prevent. Point both threads at the
   * SAME branch — what checking out `main` per thread would amount to — and git
   * refuses the second `worktree add` outright.
   */
  it("refuses a second worktree on a branch another worktree already holds", () => {
    const root = layout([THREAD_A]);
    const clone = join(root, "repos", "nadi");
    const collision = spawnSync(
      "git",
      [
        "worktree",
        "add",
        "-b",
        threadWorktreeBranch(THREAD_A),
        join(root, "threads", THREAD_B, "nadi"),
        "origin/main",
      ],
      { cwd: clone, encoding: "utf8" },
    );
    expect(collision.status).not.toBe(0);
  });

  it("sees uncommitted work in a thread's worktree at the layout's depth", async () => {
    const root = layout([THREAD_A]);
    sh("echo edited >> f1.txt", join(root, "threads", THREAD_A, "nadi"));

    const result = await runProbe(root);
    expect(result.state).toBe("dirty");
    expect(result.state === "dirty" && result.repos.map((repo) => repo.path)).toEqual([
      join(root, "threads", THREAD_A, "nadi"),
    ]);
  });

  it("sees a commit that exists only in a thread's worktree", async () => {
    const root = layout([THREAD_A]);
    const worktree = join(root, "threads", THREAD_A, "nadi");
    sh("echo work > new.txt", worktree);
    git(worktree, "add", "-A");
    git(worktree, "commit", "-qm", "local-work");

    const result = await runProbe(root);
    expect(result.state).toBe("dirty");
    expect(result.state === "dirty" && result.repos[0]?.unpushed).toBe(1);
  });
});
