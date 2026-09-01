import { getAgentByName } from "agents";
import type { Env } from "../env";
import { registryDb } from "../db/client";
import { ThreadRepository } from "../db/repositories/threads";
import { ArchivedMessageRepository } from "../db/repositories/archived-messages";
import {
  ArchivedCompactionRepository,
  type ArchivedCompactionRow,
} from "../db/repositories/archived-compactions";
import { log } from "../log";
import { releaseThreadWorkspace } from "../compute/agent-sandbox-client";
import { reconcileThreadSearchProjectionFromMessages } from "../thread-knowledge/projector";

export type ArchiveOutcome = "archived" | "already_archived" | "active_turn" | "empty_snapshot";

interface ArchiveStub {
  hasActiveTurn(): boolean | Promise<boolean>;
  exportRawHistory(): Promise<unknown[]>;
  exportCompactions(): Promise<ArchivedCompactionRow[]>;
  destroy(): void | Promise<void>;
}

/**
 * MUST be getAgentByName, not a raw `namespace.get(idFromName(...))` stub.
 * Think hydrates its transcript only in onStart(); a raw DO RPC skips onStart(),
 * so `this.messages` is still the empty cache the constructor set and the
 * export silently returns []. Archiving snapshots then destroys, so a
 * cold DO (exactly what the idle auto-archive cron reaches) would have written
 * an empty snapshot and then wiped the real transcript.
 */
async function archiveStub(env: Env, threadId: string): Promise<ArchiveStub> {
  return (await getAgentByName(env.THINK_THREAD_AGENT, threadId)) as unknown as ArchiveStub;
}

/**
 * Archive a thread by snapshotting its DO message history to D1 and then
 * destroying the DO. Order is snapshot -> set archivedAt -> destroy, so a crash
 * never leaves a destroyed DO whose history was not yet captured. Idempotent:
 * an already-archived (or missing) thread is a no-op.
 */
export async function archiveThreadCore(env: Env, threadId: string): Promise<ArchiveOutcome> {
  const db = registryDb(env);
  const repo = new ThreadRepository(db);
  const thread = await repo.getById(threadId);
  if (!thread || thread.archivedAt != null) return "already_archived";

  // Recover a partially committed archive. The snapshot is written before the
  // index flag, so a crash between those steps can leave an active-looking D1
  // row whose DO has already been evicted. Re-exporting that DO would produce an
  // empty snapshot and surface a misleading archive error; the durable snapshot
  // is already the source of truth, so only finish the index transition.
  const archivedMessages = new ArchivedMessageRepository(db);
  if (await archivedMessages.hasForThread(threadId)) {
    const messages = await archivedMessages.listForThread(threadId);
    await refreshArchivedSearchProjection(env, repo, threadId, thread.updatedAt, messages);
    await repo.archive(threadId, Date.now());
    await releaseThreadWorkspace(env, { threadId, agentId: thread.agentId });
    return "archived";
  }

  // A `legacy` row predates ThinkThreadAgent and has no DO to export from — its
  // transcript was snapshotted when the runtime was retired. Dialing Think for
  // one would export nothing, which the empty-snapshot guard below refuses, so
  // this stays safe without a second namespace.
  const stub = await archiveStub(env, threadId);
  if (await stub.hasActiveTurn()) return "active_turn";

  // Archive the RAW transcript, not the compacted view. `exportHistory()` applies
  // compaction overlays — it replaces each summarized span with one synthetic
  // summary — and archiving DESTROYS the DO, so archiving that view would delete
  // every message behind a summary for good. The summaries are kept separately
  // below, so nothing is lost either way.
  const messages = await stub.exportRawHistory();
  const compactions = await stub.exportCompactions();
  // Fail safe on an empty snapshot rather than destroy on one. An empty export
  // is indistinguishable from an unhydrated read, and the next step is
  // irreversible, so we refuse the archive instead of betting on which it is.
  // The cost of being wrong the other way is trivial: a genuinely empty thread
  // holds nothing worth reclaiming, so it just stays active (the user can
  // delete it). The skip is stamped so the oldest-first auto-archive batch does
  // not re-pick this thread on every run and starve the threads behind it.
  if (messages.length === 0) {
    log.warn("thread.archive_skipped_empty_snapshot", { threadId, runtime: thread.runtime });
    await repo.markArchiveSkipped(threadId, thread.updatedAt);
    return "empty_snapshot";
  }

  await archivedMessages.replaceForThread(threadId, messages);
  await new ArchivedCompactionRepository(db).replaceForThread(threadId, compactions);
  await refreshArchivedSearchProjection(env, repo, threadId, thread.updatedAt, messages);
  await repo.archive(threadId, Date.now());

  // AFTER the index write, never before it. Archive is terminal — the snapshot
  // is in D1, `archived_at` is set, the DO is destroyed one line below, and
  // there is no unarchive path anywhere in the app — so the thread's working
  // directory is owed a removal from the moment this row lands. Marking it
  // before the write would owe a removal for a thread whose archive could still
  // fail and leave it active.
  await releaseThreadWorkspace(env, { threadId, agentId: thread.agentId });

  try {
    await stub.destroy();
  } catch {
    // destroy() aborts the isolate after clearing storage; the RPC rejects even
    // on success, so treat it as fire-and-forget (mirrors the delete path).
  }

  log.info("thread.archived_core", { threadId, messageCount: messages.length });
  return "archived";
}

async function refreshArchivedSearchProjection(
  env: Env,
  repo: ThreadRepository,
  threadId: string,
  observedUpdatedAt: number,
  messages: unknown[],
): Promise<void> {
  await repo.invalidateSearchCheckpoint(threadId);
  try {
    await reconcileThreadSearchProjectionFromMessages(env, {
      threadId,
      messages,
      observedUpdatedAt,
    });
  } catch (error) {
    log.warn("thread.archive_search_projection_failed", {
      threadId,
      error: String(error),
    });
  }
}
