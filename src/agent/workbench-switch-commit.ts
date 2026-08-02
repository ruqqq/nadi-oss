export interface WorkbenchSwitchCommitDeps {
  threadId: string;
  now: () => number;
  commitWorkbenchSwitch: (threadId: string, at: number) => Promise<boolean>;
  execShutdown: () => Promise<unknown>;
  /**
   * Rewrites the DO-persisted `compute_state.resource_profile` to the profile
   * of the workbench just committed to. REQUIRED, and required to run before
   * `execShutdown`.
   *
   * `markAcquiring` persists the resolved profile into DO storage on the first
   * acquisition and `markAbsent` preserves it, while both readers
   * (`resolveComputeService` and `readOrAcquireRuntime`) prefer that stored
   * value over the workbench-derived config. So without this write the profile
   * frozen at the very first acquire wins FOREVER: a small→medium switch
   * re-snapshots to medium, the UI reads medium, and every subsequent sandbox
   * still provisions small — from the wrong base image too, since the profile
   * also selects the Daytona snapshot. Displayed never equals in effect, and
   * nothing self-heals.
   *
   * Rewriting rather than clearing: `ComputeState.resourceProfile` is a
   * required field, so "clear it and let config win" is not representable
   * without widening the type and every read path. Rewriting is also what the
   * design spec asks for — the stored profile is "set at acquire from the
   * resolved config, rewritten by a switch".
   */
  adoptCommittedResourceProfile: () => Promise<void>;
  /** True while subagents are running; blocks the commit so it can be retried. */
  hasBlockingWork: () => Promise<boolean>;
  /** Called when teardown fails after a successful commit. Wire to a log.warn. */
  onTeardownFailure?: (error: unknown) => void;
}

/**
 * Ordering note: `commitWorkbenchSwitch` re-snapshots BEFORE clearing the
 * pending marker. Clearing first would strand a thread whose re-snapshot threw
 * — new workbenchId, old snapshot, permit gone, no retry possible. Do not
 * reorder it.
 *
 * The one commit path. Both the agent's confirm tool and the turn-end backstop
 * call this; the conditional marker clear inside `commitWorkbenchSwitch` is the
 * exactly-once permit, so the loser is a no-op.
 *
 * Teardown failure does NOT un-commit: the snapshot has already moved to the
 * new workbench, and leaving the marker set would wedge the thread forever. A
 * stranded runtime is reclaimed by the existing idle reaper.
 */
export async function commitWorkbenchSwitchIfPending(
  deps: WorkbenchSwitchCommitDeps,
): Promise<{ committed: boolean }> {
  // Precondition, checked BEFORE committing: `execShutdown` refuses with
  // `compute_children_active` while subagents are running, and it refuses
  // before destroying anything. Committing anyway would leave the snapshot on
  // the new workbench while the old sandbox keeps running — exactly the
  // inconsistency this whole mechanism exists to prevent. Leaving the marker
  // set instead means the turn-end backstop retries once the children finish.
  if (await deps.hasBlockingWork()) return { committed: false };

  const committed = await deps.commitWorkbenchSwitch(deps.threadId, deps.now());
  if (!committed) return { committed: false };

  // Before `execShutdown`, not after: teardown failure is swallowed below, and
  // the stale stored profile would then win on the next acquire — the exact
  // divergence the switch exists to resolve. Ordering it first means the
  // profile is correct even when teardown throws.
  await deps.adoptCommittedResourceProfile();

  try {
    await deps.execShutdown();
  } catch (error) {
    // Swallowed by design — see the note above. Logged, never silent.
    deps.onTeardownFailure?.(error);
  }
  return { committed: true };
}
