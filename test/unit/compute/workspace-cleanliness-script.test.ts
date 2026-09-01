import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PROBE_SCRIPT,
  probeWorkspaceCleanliness,
} from "../../../src/compute/workspace-cleanliness";
import {
  AGENT_REPOS_ROOT,
  LEGACY_WORKSPACE_ROOT,
  PREPARED_SENTINEL_NAME,
  THREAD_WORK_ROOT,
  WORKSPACE_ROOT,
  threadWorkRoot,
  threadWorktreeBranch,
} from "../../../src/compute/workspace-layout";
import { WORKSPACE_SCAFFOLDING_COMMANDS } from "../../../src/agent/repository-preparation";

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

  /**
   * THE BOX IS NEVER LITERALLY EMPTY, and `EMPTY` still has to be reachable.
   *
   * Since P3 every `exec` goes through `ensureWorkspaceRootOnce`, which creates
   * `/workspace` and `/workspace/threads/<threadId>` BEFORE the command runs —
   * including before this probe's own exec. Preparation adds `/workspace/repos`
   * and, on a clean run, a sentinel inside the thread's directory. The old
   * emptiness test was `ls -A /workspace`, so from that change on `NOREPO EMPTY`
   * was unreachable: every repo-less box read as `no_repo` + files,
   * `resolveIdleDisposition` called that "unversioned work", preserved it at
   * every idle wake, and on a non-suspending provider it billed until something
   * deleted it. A chat thread on a setup-script-only agent that ran one command
   * is enough.
   *
   * The fixture is built from the LAYOUT HELPERS, relative to the root they
   * declare, so a new scaffolding directory that nobody teaches the probe about
   * breaks this test rather than silently re-preserving every box.
   */
  describe("the scaffolding this system makes does not count as work", () => {
    /** The same relative paths `ensureWorkspaceRootOnce` and preparation create. */
    const relative = (absolute: string) => absolute.slice(WORKSPACE_ROOT.length + 1);
    const THREAD_ID = "thr_00000000-0000-4000-8000-0000000000ee";

    /** A root laid out exactly as a box that has run one bare command. */
    function scaffolded(extra?: (root: string) => void): string {
      return workspace((root) => {
        sh(`mkdir -p "${join(root, relative(threadWorkRoot(THREAD_ID)))}"`, root);
        sh(`mkdir -p "${join(root, relative(AGENT_REPOS_ROOT))}"`, root);
        extra?.(root);
      });
    }

    it("reports EMPTY for a box holding only the layout directories", async () => {
      const root = scaffolded();
      // ANTI-VACUITY: the scaffolding really is there, so `ls -A` would say
      // "files" and the old test would have passed for the wrong reason.
      expect(readdirSync(root).sort()).toEqual([
        relative(AGENT_REPOS_ROOT),
        relative(THREAD_WORK_ROOT),
      ]);
      expect(await runProbe(root)).toEqual({ state: "no_repo", hasFiles: false });
    });

    it("reports EMPTY when the preparation sentinel is the only file", async () => {
      const root = scaffolded((base) => {
        const threadDir = join(base, relative(threadWorkRoot(THREAD_ID)));
        sh(`printf %s abc123 > "${join(threadDir, PREPARED_SENTINEL_NAME)}"`, base);
      });
      expect(await runProbe(root)).toEqual({ state: "no_repo", hasFiles: false });
    });

    it("still reports FILES for a user's file inside the thread's directory", async () => {
      const root = scaffolded((base) => {
        const threadDir = join(base, relative(threadWorkRoot(THREAD_ID)));
        sh(`echo notes > "${join(threadDir, "notes.md")}"`, base);
      });
      expect(await runProbe(root)).toEqual({ state: "no_repo", hasFiles: true });
    });

    it("still reports FILES for a user's file at the top of the box", async () => {
      const root = scaffolded((base) => sh(`echo notes > "${join(base, "notes.md")}"`, base));
      expect(await runProbe(root)).toEqual({ state: "no_repo", hasFiles: true });
    });
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
 * THE EXCLUSION LIST, PINNED TO PRODUCTION.
 *
 * The probe calls a box EMPTY — i.e. DISCARDABLE — when every non-directory
 * entry under the root is one it excludes by name. Today that is exactly the
 * preparation sentinel. The guard on that used to be the hand-built fixture
 * above: a FIXTURE, listing what somebody believed production writes. If a
 * later change makes preparation write a second scaffolding FILE — an env
 * stamp, a `.gitconfig`, a second marker — that fixture keeps passing while
 * every box in the fleet starts reading `NOREPO FILES` and is PRESERVED
 * forever. A preserved sprite bills until something deletes it; there is no
 * auto-destroy.
 *
 * So this runs PRODUCTION'S OWN scaffolding commands — every value of
 * `WORKSPACE_SCAFFOLDING_COMMANDS`, which is where those commands are DEFINED,
 * not a list kept alongside them — through a real `/bin/sh`, and then asks the
 * real probe. Add a scaffolding file and this goes red.
 *
 * When it does go red, WIDENING THE EXCLUSION LIST IS NOT THE REFLEX. Excluding
 * more makes DISCARD more likely, and discard destroys a user's filesystem —
 * the unrecoverable direction, unlike preservation, which merely costs money.
 * "This new file means the box is not empty" is a legitimate answer. It just
 * has to be a decision someone makes.
 */
describe("the probe's exclusion list against what production actually writes", () => {
  const THREAD_ID = "thr_00000000-0000-4000-8000-0000000000fe";
  const SIGNATURE = "a".repeat(64);

  /**
   * The command verbatim, with only its two absolute roots repointed at temp
   * directories — and the substitution asserted, because `LEGACY_WORKSPACE_ROOT`
   * is a real path on a developer's machine and an unsubstituted command would
   * move their directories.
   */
  function rooted(command: string, root: string, legacy: string): string {
    const out = command.split(LEGACY_WORKSPACE_ROOT).join(legacy).split(WORKSPACE_ROOT).join(root);
    expect(out, `no root to repoint in: ${command}`).not.toBe(command);
    expect(out).not.toContain(WORKSPACE_ROOT);
    expect(out).not.toContain(LEGACY_WORKSPACE_ROOT);
    return out;
  }

  /** Runs every scaffolding command, in order, against a fresh temp box. */
  function scaffoldForReal(): { root: string; commands: string[] } {
    const base = mkdtempSync(join(tmpdir(), "nadi-scaffold-"));
    // NOT named "workspace": `rooted` asserts the substituted command no longer
    // mentions `WORKSPACE_ROOT` anywhere, and a temp path ending in
    // `/workspace` would satisfy that check by accident.
    const root = join(base, "box");
    const legacy = join(base, "legacy");
    sh(`mkdir -p "${root}" "${legacy}"`, base);
    const commands = Object.values(WORKSPACE_SCAFFOLDING_COMMANDS).map((build) =>
      build({ threadId: THREAD_ID, signature: SIGNATURE }),
    );
    // Not vacuous: an empty registry would make every assertion below trivially
    // true, and `Object.values` on a renamed export is exactly that.
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) sh(rooted(command, root, legacy), base);
    return { root, commands };
  }

  it("leaves the box EMPTY after every scaffolding command production runs", async () => {
    const { root } = scaffoldForReal();

    // ANTI-VACUITY: the commands really ran and really made the layout, so
    // "EMPTY" below is a verdict about a populated box, not about a missing one.
    expect(readdirSync(root).sort()).toEqual([
      AGENT_REPOS_ROOT.slice(WORKSPACE_ROOT.length + 1),
      THREAD_WORK_ROOT.slice(WORKSPACE_ROOT.length + 1),
    ]);
    const threadDir = join(root, threadWorkRoot(THREAD_ID).slice(WORKSPACE_ROOT.length + 1));
    expect(readdirSync(threadDir)).toEqual([PREPARED_SENTINEL_NAME]);
    expect(readFileSync(join(threadDir, PREPARED_SENTINEL_NAME), "utf8")).toBe(SIGNATURE);

    expect(await runProbe(root)).toEqual({ state: "no_repo", hasFiles: false });
  });

  /**
   * The other half of the pin, and the reason widening is not the reflex: the
   * probe is NOT excluding by some broad rule that would also swallow a user's
   * file. One extra file beside the sentinel and the verdict flips to FILES.
   */
  it("reports FILES the moment anything else is written beside the sentinel", async () => {
    const { root } = scaffoldForReal();
    const threadDir = join(root, threadWorkRoot(THREAD_ID).slice(WORKSPACE_ROOT.length + 1));
    sh(`echo stamp > "${join(threadDir, ".nadi-env-stamp")}"`, root);
    expect(await runProbe(root)).toEqual({ state: "no_repo", hasFiles: true });
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

  /**
   * H2, against a REAL git: `worktree prune` clears the REGISTRATION and leaves
   * the BRANCH. Task 4's documented reclaim (remove the directory, then prune)
   * therefore leaves `nadi/thread-<id>` behind, and so does a provider restore
   * that brings `repos/` back without `threads/`.
   *
   * The first assertion is the failure that made this a work-loss seam and not
   * merely an annoyance: `add -b` on a surviving branch is a hard error, so the
   * thread would never get its checkout back — including any commit it had made
   * on that branch and not pushed. The second is the fix, and the third is why
   * `-B` (which WOULD have worked) is not it.
   */
  it("re-attaches a branch that outlived its worktree, keeping its commits", () => {
    const root = layout([THREAD_A]);
    const clone = join(root, "repos", "nadi");
    const worktree = join(root, "threads", THREAD_A, "nadi");
    const branch = threadWorktreeBranch(THREAD_A);

    // A commit that exists only on this thread's branch — the thing at stake.
    sh("echo work > only-here.txt", worktree);
    git(worktree, "add", "-A");
    git(worktree, "commit", "-qm", "thread-local");
    const head = spawnSync("git", ["rev-parse", branch], {
      cwd: clone,
      encoding: "utf8",
    }).stdout.trim();

    // The reclaim: the directory goes, the registration is pruned, the branch
    // stays. `git worktree remove` is NOT used here on purpose — this models
    // the plain `rm -rf` + `prune` the reclaim performs.
    sh(`rm -rf "${worktree}"`, root);
    git(clone, "worktree", "prune");
    expect(
      spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
        cwd: clone,
      }).status,
      "the branch must survive prune for this test to be about anything",
    ).toBe(0);

    // What the pre-fix command did.
    const recreate = spawnSync("git", ["worktree", "add", "-b", branch, worktree, "origin/main"], {
      cwd: clone,
      encoding: "utf8",
    });
    expect(recreate.status, "add -b must fail — that is the permanent skip").not.toBe(0);

    // What it does now.
    const reattach = spawnSync("git", ["worktree", "add", worktree, branch], {
      cwd: clone,
      encoding: "utf8",
    });
    expect(reattach.status, reattach.stderr).toBe(0);
    // The commit came back with it. `-B` would have reset the branch to
    // origin/main and lost exactly this.
    expect(
      spawnSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" }).stdout.trim(),
    ).toBe(head);
    expect(
      spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: worktree,
        encoding: "utf8",
      }).stdout.trim(),
    ).toBe(branch);
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
