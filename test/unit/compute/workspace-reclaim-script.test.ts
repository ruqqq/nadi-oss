import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  reclaimThreadWorkspaces,
  reclaimThreadWorkspacesScript,
} from "../../../src/agent/repository-preparation";
import {
  probeWorkspaceCleanliness,
  PROBE_SCRIPT,
} from "../../../src/compute/workspace-cleanliness";
import {
  RECLAIM_MARKER,
  WORKSPACE_ROOT,
  threadWorkRoot,
  threadWorktreeBranch,
} from "../../../src/compute/workspace-layout";

/**
 * THE RECLAIM, AGAINST A REAL GIT.
 *
 * Nothing a mock can answer is worth anything here. `git worktree prune` clears
 * a registration and leaves the branch; `worktree add -b` on a surviving branch
 * fails with exit 128 forever; a worktree's `.git` is a FILE, not a directory,
 * so a `find` that only looks for directories finds none of them. Every one of
 * those is a property of git, and a fake exec agrees with whatever the author
 * believed.
 *
 * Per `nadi-live-shell-test-eval-template` the command is used VERBATIM — built
 * by production's own `reclaimThreadWorkspacesScript` — with only its absolute
 * workspace root repointed at a temp directory, and that substitution asserted
 * so a rename cannot silently turn these into no-ops against a nonexistent
 * `/workspace`.
 */

const GIT_ID = [
  "-c",
  "user.email=reclaim@test.invalid",
  "-c",
  "user.name=reclaim",
  "-c",
  "commit.gpgsign=false",
];

const THREAD_A = "thr_00000000-0000-4000-8000-00000000000a";
const THREAD_B = "thr_00000000-0000-4000-8000-00000000000b";

function sh(script: string, cwd: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("/bin/sh", ["-c", script], { cwd, encoding: "utf8" });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function shOrThrow(script: string, cwd: string): void {
  const result = sh(script, cwd);
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

function gitOut(cwd: string, ...args: string[]): string {
  return spawnSync("git", [...GIT_ID, ...args], { cwd, encoding: "utf8" }).stdout.trim();
}

/** A bare origin with three commits, plus `repos/nadi` cloned from it. */
function box(threadIds: string[]): string {
  const base = mkdtempSync(join(tmpdir(), "nadi-reclaim-"));
  // NOT named "workspace": the substitution below asserts the rooted command no
  // longer mentions `WORKSPACE_ROOT`, and a temp path ending in `/workspace`
  // would satisfy that by accident.
  const root = join(base, "box");
  const origin = join(base, "origin.git");
  shOrThrow(`mkdir -p "${root}"`, base);
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  const seed = join(base, "seed");
  shOrThrow(`mkdir -p "${seed}"`, base);
  git(seed, "init", "-q", "-b", "main");
  for (const n of [1, 2, 3]) {
    shOrThrow(`echo ${n} > f${n}.txt`, seed);
    git(seed, "add", "-A");
    git(seed, "commit", "-qm", `c${n}`);
  }
  git(seed, "push", "-q", origin, "main:main");

  const clone = join(root, "repos", "nadi");
  shOrThrow(`mkdir -p "${join(root, "repos")}"`, root);
  git(root, "clone", "-q", origin, clone);
  for (const threadId of threadIds) {
    git(
      clone,
      "worktree",
      "add",
      "-q",
      "-b",
      threadWorktreeBranch(threadId),
      join(root, "threads", threadId, "nadi"),
      "origin/main",
    );
  }
  return root;
}

const clonePath = (root: string) => join(root, "repos", "nadi");
const worktreePath = (root: string, threadId: string) => join(root, "threads", threadId, "nadi");

/**
 * Production's command verbatim, with only `WORKSPACE_ROOT` repointed. The
 * substitution is asserted twice — that it changed something, and that nothing
 * absolute survived — because an unsubstituted command would `rm -rf` a real
 * path on a developer's machine.
 */
function rooted(command: string, root: string): string {
  const out = command.split(WORKSPACE_ROOT).join(root);
  expect(out, `no root to repoint in: ${command}`).not.toBe(command);
  expect(out).not.toContain(WORKSPACE_ROOT);
  return out;
}

/**
 * Runs the reclaim end to end: `reclaimThreadWorkspaces` builds the command, the
 * exec asserts it is byte-for-byte what production sends, and only the root is
 * repointed before /bin/sh (dash, as in the sandbox) runs it.
 */
function runReclaim(root: string, threadIds: string[]) {
  return reclaimThreadWorkspaces({
    threadIds,
    service: {
      execRun: async (input) => {
        expect(input.command).toBe(reclaimThreadWorkspacesScript(threadIds));
        const result = sh(rooted(input.command, root), root);
        return {
          processId: "p1",
          status: result.status === 0 ? ("exited" as const) : ("failed" as const),
          exitCode: result.status,
          stdout: result.stdout,
          stderr: result.stderr,
          stdoutTruncated: false,
        };
      },
    },
  });
}

function runProbe(root: string) {
  return probeWorkspaceCleanliness(async (command) => {
    expect(command).toBe(PROBE_SCRIPT);
    const rootedProbe = PROBE_SCRIPT.replace('root="/workspace"', `root="${root}"`);
    expect(rootedProbe).not.toBe(PROBE_SCRIPT);
    const result = sh(rootedProbe, root);
    return {
      exitCode: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      stdoutTruncated: false,
    };
  }, PROBE_SCRIPT);
}

describe("reclaimThreadWorkspacesScript against a real git", () => {
  it("removes only the named thread's worktree and prunes its registration", async () => {
    const root = box([THREAD_A, THREAD_B]);
    // ANTI-VACUITY: both worktrees really exist and git really knows about them.
    expect(existsSync(worktreePath(root, THREAD_A))).toBe(true);
    expect(gitOut(clonePath(root), "worktree", "list")).toContain(worktreePath(root, THREAD_A));

    const outcome = await runReclaim(root, [THREAD_A]);
    expect(outcome.ok).toBe(true);

    expect(existsSync(worktreePath(root, THREAD_A))).toBe(false);
    expect(existsSync(join(root, "threads", THREAD_A))).toBe(false);
    // The sibling thread is untouched — the reclaim is per thread, on a box the
    // whole agent shares.
    expect(existsSync(worktreePath(root, THREAD_B))).toBe(true);
    const list = gitOut(clonePath(root), "worktree", "list");
    expect(list).not.toContain(worktreePath(root, THREAD_A));
    expect(list).toContain(worktreePath(root, THREAD_B));
  });

  /**
   * THE DECISION, PINNED. The reclaim removes the worktree unconditionally and
   * leaves the BRANCH, because the branch is the only copy of any commit the
   * thread made and never pushed. `branch -D` (and `add -B`) would discard
   * those permanently, with nothing to restore from.
   *
   * The second half is what makes keeping it worth anything: `add` re-attaches
   * the surviving branch, and the commit comes back with it.
   */
  it("leaves the branch, so a re-attach brings the thread's unpushed commits back", async () => {
    const root = box([THREAD_A]);
    const worktree = worktreePath(root, THREAD_A);
    const branch = threadWorktreeBranch(THREAD_A);
    shOrThrow("echo work > only-here.txt", worktree);
    git(worktree, "add", "-A");
    git(worktree, "commit", "-qm", "thread-local");
    const head = gitOut(clonePath(root), "rev-parse", branch);

    expect((await runReclaim(root, [THREAD_A])).ok).toBe(true);

    expect(
      spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
        cwd: clonePath(root),
      }).status,
      "the branch must survive the reclaim — deleting it would drop the commit below",
    ).toBe(0);

    // `add` with no `-b`: exactly what `ensureThreadWorktree` does for a branch
    // that outlived its worktree.
    const reattach = spawnSync("git", ["worktree", "add", worktree, branch], {
      cwd: clonePath(root),
      encoding: "utf8",
    });
    expect(reattach.status, reattach.stderr).toBe(0);
    expect(gitOut(worktree, "rev-parse", "HEAD")).toBe(head);
  });

  /**
   * STEP 3, and the only reason it exists: the removal is unconditional, so this
   * line is the whole record that a user's work was destroyed. A `find` bound
   * one level short reports nothing here and the log goes silently empty.
   */
  it("reports the dirty file count and the unpushed commit count it destroyed", async () => {
    const root = box([THREAD_A]);
    const worktree = worktreePath(root, THREAD_A);
    shOrThrow("echo work > committed.txt", worktree);
    git(worktree, "add", "-A");
    git(worktree, "commit", "-qm", "never-pushed");
    shOrThrow("echo scratch > uncommitted.txt", worktree);
    shOrThrow("echo more >> f1.txt", worktree);

    const outcome = await runReclaim(root, [THREAD_A]);
    expect(outcome.ok && outcome.discarded).toEqual([
      { threadId: THREAD_A, path: worktree, changes: 2, unpushed: 1 },
    ]);
  });

  it("reports nothing for a thread whose directory is already gone, and still succeeds", async () => {
    const root = box([]);
    const outcome = await runReclaim(root, [THREAD_A]);
    // `removed` includes it: a root that is already gone owes exactly the same
    // thing a root this pass deleted owes, so its pending row must drop too.
    // Left out, the row would be retried forever against a directory that will
    // never exist.
    expect(outcome).toEqual({
      ok: true,
      discarded: [],
      removed: [THREAD_A],
      partial: false,
      auditTruncated: false,
    });
  });

  /**
   * THE WEDGE, END TO END AGAINST A REAL /bin/sh.
   *
   * The script used to `rm -rf "$root" || exit 1`. One undeletable root aborted
   * the loop, skipped the `worktree prune` tail, and returned non-zero — so the
   * caller kept EVERY pending row in the batch, including the roots it had just
   * removed. `pending` is sorted oldest-first, so the failing root was pinned at
   * the head of every later batch: no thread's directory on that box was ever
   * reclaimed again, and each wake burned three failed execs on the first tool
   * call of a turn.
   *
   * A read-only PARENT is what makes `rm -rf` genuinely fail as an unbounded
   * user — the same shape as a root the sandbox cannot unlink. Skipped as root,
   * where permission bits do not apply and the premise is not reproducible.
   */
  it.skipIf(process.getuid?.() === 0)(
    "REGRESSION: a root that cannot be removed does not strand the rest of the batch",
    async () => {
      const root = box([THREAD_A, THREAD_B]);
      const undeletable = join(root, "threads", THREAD_A);
      // A read-only directory INSIDE A's root, not A's parent: the parent is
      // shared with B, and locking that would make BOTH undeletable and prove
      // nothing about draining the batch.
      const locked = join(undeletable, "locked");
      mkdirSync(locked);
      writeFileSync(join(locked, "pinned"), "x");
      // ANTI-VACUITY: both roots exist, and only A is unremovable.
      expect(existsSync(undeletable)).toBe(true);
      expect(existsSync(join(root, "threads", THREAD_B))).toBe(true);
      chmodSync(locked, 0o500);
      try {
        expect(sh(`rm -rf "${undeletable}"`, root).status).not.toBe(0);
        expect(existsSync(undeletable)).toBe(true);

        const outcome = await runReclaim(root, [THREAD_A, THREAD_B]);

        expect(outcome.ok).toBe(true);
        // B drained even though A could not: its pending row is dropped and it
        // is not offered again.
        expect(outcome.ok && outcome.removed).toEqual([THREAD_B]);
        expect(outcome.ok && outcome.partial).toBe(true);
        // And the tail still ran — the prune is what keeps git's worktree
        // registrations from outliving the directories.
        expect(gitOut(clonePath(root), "worktree", "list")).not.toContain(
          worktreePath(root, THREAD_B),
        );
      } finally {
        chmodSync(locked, 0o700);
      }
    },
  );

  it("reclaims several threads in ONE command", async () => {
    const root = box([THREAD_A, THREAD_B]);
    const outcome = await runReclaim(root, [THREAD_A, THREAD_B]);
    expect(outcome.ok && outcome.discarded.map((entry) => entry.threadId)).toEqual([
      THREAD_A,
      THREAD_B,
    ]);
    expect(existsSync(join(root, "threads", THREAD_A))).toBe(false);
    expect(existsSync(join(root, "threads", THREAD_B))).toBe(false);
    expect(gitOut(clonePath(root), "worktree", "list").split("\n")).toHaveLength(1);
  });

  /**
   * WHICH WAY THE RECLAIM TIPS THE IDLE DECISION.
   *
   * The cleanliness probe calls a box EMPTY — i.e. DISCARDABLE — when every
   * non-directory entry under the root is one it excludes by name. The reclaim
   * writes NOTHING, so reclaiming the last thread of a box can only ever move
   * the verdict from `dirty` toward `clean`/`empty`. That is the direction we
   * want (a box holding only an archived thread's leftovers should not be
   * preserved and billed forever), and it is asserted rather than assumed
   * because the opposite — a reclaim that left a marker file behind — would
   * PRESERVE every box in the fleet and nothing else would notice.
   */
  it("leaves a box the probe reads as clean, never as unversioned work", async () => {
    const root = box([THREAD_A]);
    shOrThrow("echo scratch > uncommitted.txt", worktreePath(root, THREAD_A));
    // ANTI-VACUITY: dirty first, so "clean" below is a verdict about a box that
    // really did hold something to lose.
    expect((await runProbe(root)).state).toBe("dirty");

    expect((await runReclaim(root, [THREAD_A])).ok).toBe(true);

    // The agent's clone survives the reclaim and is itself clean, so the box is
    // discardable rather than merely empty.
    expect((await runProbe(root)).state).toBe("clean");
    expect(existsSync(clonePath(root))).toBe(true);
  });

  it("refuses to build a command with no threads, rather than emitting an empty `for`", () => {
    expect(() => reclaimThreadWorkspacesScript([])).toThrow();
  });

  it("names each thread's work root through the layout helper", () => {
    const script = reclaimThreadWorkspacesScript([THREAD_A]);
    expect(script).toContain(threadWorkRoot(THREAD_A));
    expect(script).toContain(RECLAIM_MARKER);
  });
});

describe("reclaimThreadWorkspaces output handling", () => {
  function serviceReturning(result: {
    exitCode: number;
    stdout: string;
    stderr?: string;
    stdoutTruncated?: boolean;
  }) {
    return {
      execRun: async () => ({
        processId: "p1",
        status: (result.exitCode === 0 ? "exited" : "failed") as "exited" | "failed",
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr ?? "",
        stdoutTruncated: result.stdoutTruncated ?? false,
      }),
    };
  }

  /**
   * A NON-ZERO EXIT NO LONGER MEANS NOTHING HAPPENED, and that is the whole
   * point of the per-root accounting.
   *
   * The script used to `exit 1` on the first failing `rm -rf`, which aborted the
   * loop, skipped the `worktree prune` tail, and made this function report total
   * failure — so the caller kept EVERY pending row in the batch, including the
   * roots already removed. `pending` is sorted oldest-first, so the failing root
   * was pinned at the head of every later batch: nothing on that box was ever
   * reclaimed again, and each wake burned three failed execs on the first tool
   * call of a turn.
   */
  it("REGRESSION: a partial failure still reports the roots that WERE removed", async () => {
    const outcome = await reclaimThreadWorkspaces({
      threadIds: [THREAD_A, THREAD_B],
      service: serviceReturning({
        exitCode: 1,
        stdout: `${RECLAIM_MARKER}\tDONE\t${threadWorkRoot(THREAD_A)}`,
        stderr: "rm: permission denied",
      }),
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.removed).toEqual([THREAD_A]);
    expect(outcome.ok && outcome.partial).toBe(true);
  });

  /**
   * The opposite of the cleanliness probe's rule, deliberately. By the time this
   * output is read the directories are already gone, so refusing to parse would
   * keep the pending row and re-run `rm -rf` on every turn forever.
   */
  it("ignores output it cannot parse rather than failing the reclaim", async () => {
    const outcome = await reclaimThreadWorkspaces({
      threadIds: [THREAD_A],
      service: serviceReturning({
        exitCode: 0,
        stdout: [
          "mock: ran a command",
          `${RECLAIM_MARKER}\ttoo\tfew`,
          `${RECLAIM_MARKER}\t${threadWorkRoot("thr_someone-else")}\t/x\t1\t1`,
          `${RECLAIM_MARKER}\t${threadWorkRoot(THREAD_A)}\t/w\tnot-a-number\t2`,
        ].join("\n"),
      }),
    });
    // The unknown root is dropped (it names no thread we asked about) and the
    // unparseable count becomes -1 rather than taking the line down.
    expect(outcome).toEqual({
      ok: true,
      discarded: [{ threadId: THREAD_A, path: "/w", changes: -1, unpushed: 2 }],
      // The exit was ZERO, which is itself the proof that every requested root
      // is gone — the loop's only route to a non-zero status is a failed
      // `rm -rf`. Deriving `removed` from parsed stdout instead would make a
      // truncated or garbled audit look like a failed removal and retry the
      // `rm -rf` forever. The DONE lines carry the answer only when the exit
      // says something went wrong.
      removed: [THREAD_A],
      partial: false,
      auditTruncated: false,
    });
  });

  it("flags a truncated audit without failing the reclaim", async () => {
    const outcome = await reclaimThreadWorkspaces({
      threadIds: [THREAD_A],
      service: serviceReturning({
        exitCode: 0,
        stdout: `${RECLAIM_MARKER}\tDONE\t${threadWorkRoot(THREAD_A)}`,
        stdoutTruncated: true,
      }),
    });
    expect(outcome).toEqual({
      ok: true,
      discarded: [],
      removed: [THREAD_A],
      partial: false,
      auditTruncated: true,
    });
  });
});
