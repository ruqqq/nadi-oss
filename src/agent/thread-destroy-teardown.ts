import { log } from "../log";
import type { ThreadComputeService } from "../compute/thread-service";

export interface ThreadDestroyComputeServiceResolution {
  service: Pick<ThreadComputeService, "execShutdown"> &
    Partial<Pick<ThreadComputeService, "releaseQuotaSlot">>;
}

export interface ThreadDestroyTeardownDeps {
  threadId: string;
  logPrefix: string;
  cancelActiveSubagents?: () => Promise<void>;
  resolveComputeService: () => Promise<ThreadDestroyComputeServiceResolution | null>;
}

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

  let resolved: ThreadDestroyComputeServiceResolution | null = null;
  try {
    resolved = await deps.resolveComputeService();
    await resolved?.service.execShutdown({ confirm: true });
  } catch (error) {
    log.warn(`${deps.logPrefix}.destroy_sandbox_reap_failed`, {
      threadId: deps.threadId,
      error: String(error),
    });
  }

  // execShutdown throws (e.g. compute_children_active) without releasing, and
  // DO storage is wiped right after this — a surviving ledger row would then
  // hold a workspace slot for a thread that no longer exists, and keep being
  // offered as a reclaim candidate. Release explicitly; never block destroy.
  try {
    await resolved?.service.releaseQuotaSlot?.();
  } catch (error) {
    log.warn(`${deps.logPrefix}.destroy_quota_release_failed`, {
      threadId: deps.threadId,
      error: String(error),
    });
  }
}
