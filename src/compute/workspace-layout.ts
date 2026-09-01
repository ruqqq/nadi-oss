import { posix as path } from "node:path";

/**
 * THE one place the sandbox filesystem layout is written down.
 *
 * Since P3 a sandbox belongs to an AGENT and is shared by every thread of that
 * agent, so "/workspace" alone is no longer a meaningful working directory: two
 * threads editing the same checkout would stomp on each other. The box is split
 * in two:
 *
 * ```
 * /workspace/repos/<checkoutPathName>          the agent's canonical clone
 * /workspace/threads/<threadId>/               a thread's working directory
 * /workspace/threads/<threadId>/<checkoutPathName>   its git worktree of that clone
 * ```
 *
 * Every path above is constructed HERE and nowhere else. Task 4 reclaims a
 * thread's worktree on archive/delete and consumes these same helpers — a
 * second construction site is how a reclaim deletes the wrong directory (or
 * misses it, and the filesystem grows forever).
 */

/** The root every runtime is provisioned with. */
export const WORKSPACE_ROOT = "/workspace";

/** Where the agent's canonical clones live; one per configured repository. */
export const AGENT_REPOS_ROOT = `${WORKSPACE_ROOT}/repos`;

/** Where per-thread working directories live; one per thread of the agent. */
export const THREAD_WORK_ROOT = `${WORKSPACE_ROOT}/threads`;

/**
 * Checkouts made before the /workspace move lived here. Migrated in place so a
 * suspended sandbox is not re-cloned (which would strand uncommitted work).
 */
export const LEGACY_WORKSPACE_ROOT = "/home/exedev/work";

/**
 * Top-level names under `/workspace` that are LAYOUT, not checkouts.
 *
 * The pre-P3 layout put clones directly at `/workspace/<name>`, and the root
 * preparation migrates those into `AGENT_REPOS_ROOT`. That sweep must not pick
 * up the two directories it is sweeping into.
 */
export const RESERVED_WORKSPACE_DIR_NAMES = ["repos", "threads"] as const;

/** Branch prefix for the branch each thread's worktree is checked out on. */
const THREAD_BRANCH_PREFIX = "nadi/thread-";

const THREAD_ID_PREFIX = "thr_";

// Deliberately strict. Both segments are interpolated into shell commands and
// into filesystem paths, and both come from ids we generate (`thr_<uuid>`) or
// from a user-editable `checkoutPathName`. A separator or a dot-segment here
// escapes the layout — `..` in a checkout name would put a "thread worktree"
// on top of the agent's canonical clone.
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertSafeSegment(value: string, kind: string): string {
  if (!SAFE_SEGMENT.test(value) || value === "." || value === "..") {
    throw new Error(`unsafe ${kind} for sandbox layout: ${JSON.stringify(value)}`);
  }
  return value;
}

/** `/workspace/repos/<checkoutPathName>` — the agent's canonical clone. */
export function agentClonePath(checkoutPathName: string): string {
  return path.join(AGENT_REPOS_ROOT, assertSafeSegment(checkoutPathName, "checkout path name"));
}

/**
 * `/workspace/threads/<threadId>` — the thread's working directory.
 *
 * This is the cwd every `exec` defaults to and the root every relative file-tool
 * path resolves against, so the two agree on what `src/app.ts` means.
 */
export function threadWorkRoot(threadId: string): string {
  return path.join(THREAD_WORK_ROOT, assertSafeSegment(threadId, "thread id"));
}

/** `/workspace/threads/<threadId>/<checkoutPathName>` — the thread's worktree. */
export function threadWorktreePath(threadId: string, checkoutPathName: string): string {
  return path.join(
    threadWorkRoot(threadId),
    assertSafeSegment(checkoutPathName, "checkout path name"),
  );
}

/**
 * The branch a thread's worktree is checked out on.
 *
 * `git worktree add` REFUSES a branch that is already checked out in another
 * worktree, so every thread wanting the repository's default branch would
 * collide on the second thread. A branch per thread is the fix, and a DETACHED
 * head is not: this repo's own guidance calls that "the classic way to lose
 * work", which matters more once a later task reclaims worktrees unconditionally.
 *
 * The FULL thread id (minus its `thr_` prefix) rather than a truncation: a
 * shortened id can collide across threads of one agent, and the failure mode of
 * a collision is `worktree add` failing for a user's brand-new thread.
 */
export function threadWorktreeBranch(threadId: string): string {
  const safe = assertSafeSegment(threadId, "thread id");
  return `${THREAD_BRANCH_PREFIX}${safe.startsWith(THREAD_ID_PREFIX) ? safe.slice(THREAD_ID_PREFIX.length) : safe}`;
}

/**
 * How deep under `WORKSPACE_ROOT` a repository's `.git` can sit — DERIVED from
 * the layout above, never written down as a number.
 *
 * The deepest one is a thread's worktree:
 * `/workspace` / `threads` / `<threadId>` / `<name>` / `.git` — three segments
 * plus the `.git` entry itself. The cleanliness probe bounds its `find` with
 * this, and a bound one level short reports `no_repo`, which is the "nothing to
 * lose" verdict that lets an idle box holding uncommitted work be discarded.
 * Deriving it means moving a directory in this file cannot leave that scan
 * behind.
 */
export const WORKSPACE_GIT_SCAN_DEPTH =
  threadWorktreePath("thr_depth-probe", "repo")
    .slice(WORKSPACE_ROOT.length + 1)
    .split("/").length + 1;
