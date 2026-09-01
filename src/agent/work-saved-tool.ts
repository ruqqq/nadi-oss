import { log } from "../log";
import type { WorkspaceCleanliness } from "../compute/workspace-cleanliness";

export interface WorkSavedToolDeps {
  probe: () => Promise<WorkspaceCleanliness>;
  setDeclaredClean: (clean: boolean) => Promise<void>;
  threadId?: string;
}

/**
 * Declares the sandbox's work saved, but only ACCEPTS the declaration when a
 * fresh probe agrees. There is no override: a dirty or unverifiable workspace
 * always refuses, and the bit is only ever set against a state that was just
 * checked, not merely claimed. `no_repo` with files present also refuses —
 * without that arm, unversioned work would sail through as "zero dirty
 * repos" and be discarded on idle.
 */
export async function confirmWorkSaved(deps: WorkSavedToolDeps): Promise<string> {
  const state = await deps.probe();
  switch (state.state) {
    case "clean": {
      await deps.setDeclaredClean(true);
      return "Workspace verified clean. The sandbox may now be discarded when idle.";
    }
    case "no_repo": {
      if (!state.hasFiles) {
        await deps.setDeclaredClean(true);
        return "Workspace is empty. The sandbox may now be discarded when idle.";
      }
      log.info("compute.work_saved_refused", {
        threadId: deps.threadId,
        reason: "no_repo",
        dirtyRepoCount: 0,
      });
      return (
        "Refused: the sandbox has files that are not under version control, so they " +
        "cannot be verified as saved. Run `git init` and commit them, or remove the " +
        "files, then call confirm_work_saved again."
      );
    }
    case "dirty": {
      const repoLines = state.repos
        .map((repo) => {
          // changes and unpushed can't both be empty here — parseRepoLine
          // treats that combination as clean and never surfaces it as dirty.
          const detail =
            repo.changes.length > 0
              ? repo.unpushed > 0
                ? `${repo.changes.join(", ")}; ${repo.unpushed} unpushed commit(s)`
                : repo.changes.join(", ")
              : `working tree clean; ${repo.unpushed} unpushed commit(s)`;
          return `- ${repo.path}: ${detail}`;
        })
        .join("\n");
      log.info("compute.work_saved_refused", {
        threadId: deps.threadId,
        reason: "dirty",
        dirtyRepoCount: state.repos.length,
      });
      return (
        "Refused: the workspace is not fully saved. The following repositories have " +
        "uncommitted changes or unpushed commits:\n" +
        `${repoLines}\n` +
        "Commit, push, delete, or add an ignore rule for the offending paths, then call " +
        "confirm_work_saved again."
      );
    }
    case "probe_failed": {
      log.info("compute.work_saved_refused", {
        threadId: deps.threadId,
        reason: "probe_failed",
        dirtyRepoCount: 0,
      });
      return (
        "Refused: could not verify the workspace's git state " +
        `(${state.reason}). Retry confirm_work_saved once the sandbox is reachable.`
      );
    }
  }
}
