import type { Env } from "../env";
import { registryBinding, registryDb } from "../db/client";
import { ArchivedMessageRepository } from "../db/repositories/archived-messages";
import { ThreadSearchProjectionRepository } from "../db/repositories/thread-search-projection";
import { ThreadRepository } from "../db/repositories/threads";
import {
  reconcileThreadSearchProjection,
  reconcileThreadSearchProjectionFromMessages,
} from "./projector";
import { hasLiveTranscript } from "../agent/thread-runtime";
import { log } from "../log";

export const SEARCH_REPAIR_BATCH = 10;

/** Ceiling for a caller-supplied batch, so one invocation cannot run unbounded. */
export const SEARCH_REPAIR_MAX_BATCH = 200;

export type ThreadSearchRepairResult = {
  selected: number;
  succeeded: number;
  failed: number;
  /** Stale threads still outstanding AFTER this batch — 0 means fully drained. */
  remaining: number;
};

export async function repairStaleThreadSearchProjections(
  env: Env,
  limit: number = SEARCH_REPAIR_BATCH,
): Promise<ThreadSearchRepairResult> {
  const projection = new ThreadSearchProjectionRepository(registryBinding(env));
  const batch = Math.min(Math.max(Math.floor(limit), 0), SEARCH_REPAIR_MAX_BATCH);
  const selected = await projection.selectStaleThreads(batch);
  let succeeded = 0;
  let failed = 0;

  for (const candidate of selected) {
    try {
      const thread = await new ThreadRepository(registryDb(env)).getById(candidate.id);
      if (!thread || thread.kind === "feedback") {
        continue;
      }

      // `hasLiveTranscript`, not `archivedAt`, decides the source. A retired-runtime
      // row is unarchived but has no DO to read, and it MUST still take the D1 path:
      // a repair that merely skips never advances the projection checkpoint, so the
      // row stays stale, stays oldest-first, and eats a batch slot on every run
      // forever — the same starvation `recordRepairFailure` exists to prevent.
      if (hasLiveTranscript(thread)) {
        await reconcileThreadSearchProjection(env, thread.id);
      } else {
        const messages = await new ArchivedMessageRepository(registryDb(env)).listForThread(
          thread.id,
        );
        await reconcileThreadSearchProjectionFromMessages(env, {
          threadId: thread.id,
          messages,
          observedUpdatedAt: thread.updatedAt,
        });
      }
      succeeded += 1;
    } catch (error) {
      failed += 1;
      // Rotate the failure behind its healthy peers. Without this a thread that
      // throws every run stays oldest-first forever and eats a batch slot, so a
      // batch of N permanent failures stalls the backlog at zero progress.
      await projection.recordRepairFailure(candidate.id).catch((stampError) => {
        log.warn("thread_search_repair.stamp_failed", {
          threadId: candidate.id,
          error: String(stampError),
        });
      });
      log.warn("thread_search_repair.failed", {
        threadId: candidate.id,
        error: String(error),
      });
    }
  }

  return {
    selected: selected.length,
    succeeded,
    failed,
    remaining: await projection.countStaleThreads(),
  };
}
