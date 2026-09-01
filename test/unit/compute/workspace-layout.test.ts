import { describe, expect, it } from "vitest";
import {
  AGENT_REPOS_ROOT,
  RESERVED_WORKSPACE_DIR_NAMES,
  THREAD_WORK_ROOT,
  WORKSPACE_GIT_SCAN_DEPTH,
  WORKSPACE_ROOT,
  agentClonePath,
  threadWorkRoot,
  threadWorktreeBranch,
  threadWorktreePath,
} from "../../../src/compute/workspace-layout";

/**
 * These helpers are the ONLY place the sandbox layout is constructed, and Task 4
 * reclaims a thread's worktree by calling them. A path built a second way — in
 * the reclaim, in a test fixture, anywhere — is how a reclaim deletes the wrong
 * directory or silently misses the right one. So the shapes are pinned here.
 */
describe("workspace layout", () => {
  const THREAD_ID = "thr_9e0b60c1-0000-4000-8000-000000000001";

  it("puts the agent's clones and the threads' worktrees in separate roots", () => {
    expect(agentClonePath("nadi")).toBe("/workspace/repos/nadi");
    expect(threadWorkRoot(THREAD_ID)).toBe(`/workspace/threads/${THREAD_ID}`);
    expect(threadWorktreePath(THREAD_ID, "nadi")).toBe(`/workspace/threads/${THREAD_ID}/nadi`);

    // A thread's worktree is never the agent's clone, for any repository.
    expect(threadWorktreePath(THREAD_ID, "nadi")).not.toBe(agentClonePath("nadi"));
    expect(AGENT_REPOS_ROOT.startsWith(`${WORKSPACE_ROOT}/`)).toBe(true);
    expect(THREAD_WORK_ROOT.startsWith(`${WORKSPACE_ROOT}/`)).toBe(true);
  });

  /**
   * The migration in `rootPreparationCommand` sweeps every top-level directory
   * under `/workspace` into `repos/`. If the two layout directories were not
   * reserved it would sweep them into themselves.
   */
  it("reserves exactly the top-level names the layout itself owns", () => {
    const owned = [AGENT_REPOS_ROOT, THREAD_WORK_ROOT].map((path) =>
      path.slice(WORKSPACE_ROOT.length + 1),
    );
    expect([...RESERVED_WORKSPACE_DIR_NAMES].sort()).toEqual(owned.sort());
  });

  it("gives every thread its own branch, derived from the full id", () => {
    expect(threadWorktreeBranch(THREAD_ID)).toBe(
      "nadi/thread-9e0b60c1-0000-4000-8000-000000000001",
    );
    expect(threadWorktreeBranch("thr_a")).not.toBe(threadWorktreeBranch("thr_b"));
    // Two ids sharing a prefix must not share a branch: `worktree add` refuses a
    // branch another worktree holds, so a truncating scheme would fail a user's
    // brand-new thread the moment it collided.
    expect(threadWorktreeBranch("thr_0000000000000000a")).not.toBe(
      threadWorktreeBranch("thr_0000000000000000b"),
    );
  });

  /**
   * Both segments are interpolated into shell commands AND into paths.
   * `checkoutPathName` is user-editable, so a traversal there would put a
   * "thread worktree" on top of the agent's shared clone — the directory every
   * other thread's worktree is registered against.
   */
  it.each([
    ["..", "traversal"],
    [".", "dot"],
    ["../repos", "relative escape"],
    ["a/b", "separator"],
    ["", "empty"],
    ["-rf", "leading dash"],
    ["a b", "space"],
    ["a;rm -rf /", "shell metacharacters"],
  ])("rejects %j as a checkout path name (%s)", (value) => {
    expect(() => agentClonePath(value)).toThrow("unsafe checkout path name");
    expect(() => threadWorktreePath("thr_1", value)).toThrow("unsafe checkout path name");
  });

  it.each([
    ["".valueOf(), "empty"],
    ["..", "traversal"],
    ["a/b", "separator"],
  ])("rejects %j as a thread id (%s)", (value) => {
    expect(() => threadWorkRoot(value)).toThrow("unsafe thread id");
    expect(() => threadWorktreeBranch(value)).toThrow("unsafe thread id");
  });

  /**
   * The cleanliness probe's `find` bound. Derived, so moving a directory in the
   * layout cannot leave the scan behind — and a scan one level short reports
   * `no_repo`, the verdict that lets an idle box holding uncommitted work be
   * discarded.
   */
  it("derives a scan depth that reaches a thread worktree's .git", () => {
    const depthOfGit =
      threadWorktreePath(THREAD_ID, "nadi")
        .slice(WORKSPACE_ROOT.length + 1)
        .split("/").length + 1;
    expect(WORKSPACE_GIT_SCAN_DEPTH).toBe(depthOfGit);
    // And it still reaches the agent's shallower clones.
    expect(WORKSPACE_GIT_SCAN_DEPTH).toBeGreaterThanOrEqual(
      agentClonePath("nadi")
        .slice(WORKSPACE_ROOT.length + 1)
        .split("/").length + 1,
    );
  });
});
