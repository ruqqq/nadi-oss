import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "../schema";
import { archivedCompaction } from "../schema";

/** 6 bound params per row here; 12 rows stays well under D1's ~100 cap. */
const ARCHIVE_INSERT_CHUNK = 12;

export interface ArchivedCompactionRow {
  id: string;
  fromMessageId: string;
  toMessageId: string;
  summary: string;
}

/**
 * The compaction summaries of an archived thread.
 *
 * The archive stores the RAW transcript (see `exportRawHistory`) so nothing is
 * destroyed. These rows keep the summaries alongside it, so an archived thread can
 * still be read as the digest rather than the whole wall of messages — without the
 * summary ever being stored as a message, which is what corrupted live threads.
 */
export class ArchivedCompactionRepository {
  constructor(private readonly db: DrizzleD1Database<typeof schema>) {}

  /** Replace the entire set for a thread: one row per overlay, seq = index. */
  async replaceForThread(threadId: string, compactions: ArchivedCompactionRow[]): Promise<void> {
    await this.db.delete(archivedCompaction).where(eq(archivedCompaction.threadId, threadId));
    if (compactions.length === 0) return;
    const rows = compactions.map((c, seq) => ({
      threadId,
      seq,
      compactionId: c.id,
      fromMessageId: c.fromMessageId,
      toMessageId: c.toMessageId,
      summary: c.summary,
    }));
    // Chunked for the same reason as the message snapshot: D1 caps bound parameters
    // per query, and this table binds 6 per row.
    for (let i = 0; i < rows.length; i += ARCHIVE_INSERT_CHUNK) {
      await this.db.insert(archivedCompaction).values(rows.slice(i, i + ARCHIVE_INSERT_CHUNK));
    }
  }

  async listForThread(threadId: string): Promise<ArchivedCompactionRow[]> {
    const rows = await this.db
      .select()
      .from(archivedCompaction)
      .where(eq(archivedCompaction.threadId, threadId))
      .orderBy(archivedCompaction.seq);
    return rows.map((r) => ({
      id: r.compactionId,
      fromMessageId: r.fromMessageId,
      toMessageId: r.toMessageId,
      summary: r.summary,
    }));
  }

  async deleteForThread(threadId: string): Promise<void> {
    await this.db.delete(archivedCompaction).where(eq(archivedCompaction.threadId, threadId));
  }
}
