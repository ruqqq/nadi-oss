import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./schema";
import { attachments } from "./schema";

export type AttachmentRow = typeof attachments.$inferSelect;
export type NewAttachment = typeof attachments.$inferInsert;

export class AttachmentRepository {
  private db: DrizzleD1Database<typeof schema>;

  constructor(d1: D1Database) {
    this.db = drizzle(d1, { schema });
  }

  async insert(row: NewAttachment): Promise<void> {
    await this.db.insert(attachments).values(row);
  }

  async getByIdInThread(id: string, threadId: string): Promise<AttachmentRow | null> {
    const row = await this.db
      .select()
      .from(attachments)
      .where(and(eq(attachments.id, id), eq(attachments.threadId, threadId)))
      .get();
    return row ?? null;
  }

  async listByThread(threadId: string): Promise<AttachmentRow[]> {
    return this.db.select().from(attachments).where(eq(attachments.threadId, threadId)).all();
  }

  async markCommitted(ids: string[], threadId: string): Promise<void> {
    if (ids.length === 0) return;
    await this.db
      .update(attachments)
      .set({ status: "committed" })
      .where(and(inArray(attachments.id, ids), eq(attachments.threadId, threadId)));
  }

  // Incremented BEFORE the extraction call, so a Worker eviction mid-extraction
  // cannot produce an unbounded retry loop.
  async beginExtractionAttempt(id: string, threadId: string): Promise<void> {
    await this.db
      .update(attachments)
      .set({ extractedAttempts: sql`${attachments.extractedAttempts} + 1` })
      .where(and(eq(attachments.id, id), eq(attachments.threadId, threadId)));
  }

  async saveExtraction(id: string, threadId: string, text: string, source: string): Promise<void> {
    await this.db
      .update(attachments)
      .set({
        extractedText: text,
        extractedSource: source,
        extractedAt: Date.now(),
        extractedError: null,
      })
      .where(and(eq(attachments.id, id), eq(attachments.threadId, threadId)));
  }

  async recordExtractionFailure(id: string, threadId: string, error: string): Promise<void> {
    await this.db
      .update(attachments)
      .set({ extractedError: error, extractedAt: Date.now() })
      .where(and(eq(attachments.id, id), eq(attachments.threadId, threadId)));
  }
}
