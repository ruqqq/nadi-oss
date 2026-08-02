import { and, asc, isNull, lt, or } from "drizzle-orm";
import type { Env } from "../env";
import { registryDb } from "../db/client";
import { threadIndex } from "../db/schema";
import { archiveThreadCore } from "./archive-thread";
import { log } from "../log";

/** Threads with no activity for this many days are auto-archived. */
export const AUTO_ARCHIVE_IDLE_DAYS = 14;
/**
 * Max threads archived per cron run — bounds subrequests; remainder next run.
 *
 * Cost per thread, honestly counted: ~8 from this Worker (thread lookup,
 * getAgentByName, hasActiveTurn, exportHistory, snapshot delete + insert,
 * archive update, destroy) PLUS the fan-out of the cold DO wake that
 * getAgentByName forces — ThinkThreadAgent.onStart resolves runtime config,
 * lists enabled MCP servers, and does a token lookup + addMcpServer (network)
 * per server, i.e. roughly 5 + 4 per MCP server. A workspace with three MCP
 * servers lands around ~25 per thread, so 25 threads keeps a run near ~625,
 * under the Workers 1000-subrequest-per-invocation ceiling. A large first sweep
 * drains over successive idempotent daily runs.
 */
export const AUTO_ARCHIVE_BATCH = 25;
const DAY_MS = 86_400_000;

export async function autoArchiveIdleThreads(
  env: Env,
  now: number = Date.now(),
): Promise<{ archived: number; skipped: number; failed: number }> {
  const db = registryDb(env);
  const cutoff = now - AUTO_ARCHIVE_IDLE_DAYS * DAY_MS;

  // Threads the archive already refused (an empty transcript) are excluded until
  // they see activity again. They are the OLDEST rows and their updatedAt never
  // moves, so without this they permanently occupy the head of this oldest-first
  // batch and no other thread is ever reached.
  const stale = await db
    .select({ id: threadIndex.id })
    .from(threadIndex)
    .where(
      and(
        isNull(threadIndex.archivedAt),
        lt(threadIndex.updatedAt, cutoff),
        or(
          isNull(threadIndex.archiveSkippedUpdatedAt),
          lt(threadIndex.archiveSkippedUpdatedAt, threadIndex.updatedAt),
        ),
      ),
    )
    .orderBy(asc(threadIndex.updatedAt))
    .limit(AUTO_ARCHIVE_BATCH)
    .all();

  let archived = 0;
  let skipped = 0;
  let failed = 0;
  for (const { id } of stale) {
    try {
      const outcome = await archiveThreadCore(env, id);
      if (outcome === "archived") archived += 1;
      else skipped += 1;
    } catch (error) {
      // A THROW is not a skip. `skipped` counts benign outcomes — a thread that is
      // mid-turn, or empty, or already archived — and a thread that fails on every
      // run forever used to be indistinguishable from one that was merely busy.
      // (A 120-message thread did exactly that: the snapshot INSERT blew D1's
      // bound-parameter cap, so it threw on every pass and never archived, while
      // the summary line just said "skipped".) Count it separately so a persistent
      // failure is visible in the one line an operator actually reads.
      failed += 1;
      log.warn("auto_archive.failed", { threadId: id, error: String(error) });
    }
  }

  log.info("auto_archive.done", { archived, skipped, failed, scanned: stale.length });
  return { archived, skipped, failed };
}
