import { log } from "../log";

export interface ThreadDestroyTeardownDeps {
  threadId: string;
  logPrefix: string;
  cancelActiveSubagents?: () => Promise<void>;
}

/**
 * What a thread DO must finish before its storage is wiped.
 *
 * **IT NO LONGER TOUCHES THE SANDBOX, AND THAT IS THE POINT.** Until P3 this
 * called `execShutdown({ confirm: true })` and then dropped the quota row,
 * which was right while the box was per-thread: destroying it destroyed exactly
 * the thread that was going away. Since the DO was re-keyed by agent, the same
 * two calls DESTROY THE AGENT'S SHARED MACHINE — every sibling thread's
 * worktree, the canonical clones, the installed tooling — on the archive of one
 * thread. Archiving a chat would have wiped the agent's filesystem.
 *
 * A thread's own working directory is still reclaimed, lazily and by the box
 * itself: `repo.archive` marks it `pending_removal` and the next turn that has
 * the box awake removes it (Task 4). Nothing else of the thread's is on the
 * machine.
 *
 * The quota row is the AGENT's, not the thread's, so it must not be dropped
 * here either: it is what tells the orphan reconciler the agent's sprite is
 * accounted for.
 */
export async function teardownThreadBeforeDestroy(deps: ThreadDestroyTeardownDeps): Promise<void> {
  if (deps.cancelActiveSubagents) {
    try {
      await deps.cancelActiveSubagents();
    } catch (error) {
      log.warn(`${deps.logPrefix}.destroy_cancel_subagents_failed`, {
        threadId: deps.threadId,
        error: String(error),
      });
    }
  }
}
