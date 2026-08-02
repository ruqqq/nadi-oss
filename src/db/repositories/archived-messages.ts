import { and, asc, desc, eq, gt, lt } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type * as schema from "../schema";
import { archivedMessage } from "../schema";

/**
 * Rows per INSERT. D1 allows ~100 bound parameters per query; this table binds 3
 * per row, so 25 keeps a wide margin without making the write chatty.
 */
const ARCHIVE_INSERT_CHUNK = 25;

export class ArchivedMessageRepository {
  constructor(private readonly db: DrizzleD1Database<typeof schema>) {}

  /**
   * Replace the entire snapshot for a thread: one row per message, seq = index.
   *
   * Inserted in chunks because D1 caps the number of bound parameters per query
   * (3 per row here). A single multi-row INSERT would throw on a long thread — and
   * archiving is snapshot-then-DESTROY, so an insert that fails part-way must never
   * be the thing that gets discovered late. The throw is safe (it happens before the
   * DO is destroyed), but the archive would simply never succeed for big threads.
   */
  async replaceForThread(threadId: string, messages: unknown[]): Promise<void> {
    await this.db.delete(archivedMessage).where(eq(archivedMessage.threadId, threadId));
    if (messages.length === 0) return;
    const rows = messages.map((message, seq) => ({
      threadId,
      seq,
      payload: JSON.stringify(message),
    }));
    for (let i = 0; i < rows.length; i += ARCHIVE_INSERT_CHUNK) {
      await this.db.insert(archivedMessage).values(rows.slice(i, i + ARCHIVE_INSERT_CHUNK));
    }
  }

  /** Return the thread's snapshot messages in order (empty when none). */
  async listForThread(threadId: string): Promise<unknown[]> {
    const rows = await this.db
      .select({ payload: archivedMessage.payload })
      .from(archivedMessage)
      .where(eq(archivedMessage.threadId, threadId))
      .orderBy(asc(archivedMessage.seq))
      .all();
    return rows.map((row) => JSON.parse(row.payload) as unknown);
  }

  async listStatsForThread(input: {
    threadId: string;
    afterSeq?: number;
    order: "chronological" | "reverse";
    limit: number;
  }): Promise<{
    stats: Array<{ id: string; position: number; bytes: number }>;
    nextPosition?: number;
  }> {
    const keyset =
      input.afterSeq === undefined
        ? undefined
        : input.order === "chronological"
          ? gt(archivedMessage.seq, input.afterSeq)
          : lt(archivedMessage.seq, input.afterSeq);
    const rows = await this.db
      .select({ seq: archivedMessage.seq, payload: archivedMessage.payload })
      .from(archivedMessage)
      .where(and(eq(archivedMessage.threadId, input.threadId), keyset))
      .orderBy(
        input.order === "chronological" ? asc(archivedMessage.seq) : desc(archivedMessage.seq),
      )
      .limit(input.limit + 1)
      .all();
    const page = rows.slice(0, input.limit);
    const result: {
      stats: Array<{ id: string; position: number; bytes: number }>;
      nextPosition?: number;
    } = {
      stats: page.map((row) => ({
        id: stableMessageId(row.payload, row.seq),
        position: row.seq,
        bytes: new TextEncoder().encode(row.payload).byteLength,
      })),
    };
    const last = page[page.length - 1];
    if (rows.length > input.limit && last !== undefined) {
      result.nextPosition = last.seq;
    }
    return result;
  }

  async getBySeq(threadId: string, seq: number): Promise<unknown | null> {
    const row = await this.db
      .select({ payload: archivedMessage.payload })
      .from(archivedMessage)
      .where(and(eq(archivedMessage.threadId, threadId), eq(archivedMessage.seq, seq)))
      .get();
    if (row === undefined) return null;
    try {
      return JSON.parse(row.payload) as unknown;
    } catch {
      return null;
    }
  }

  /** Whether a non-empty archive snapshot exists for the thread. */
  async hasForThread(threadId: string): Promise<boolean> {
    const row = await this.db
      .select({ threadId: archivedMessage.threadId })
      .from(archivedMessage)
      .where(eq(archivedMessage.threadId, threadId))
      .limit(1)
      .get();
    return row !== undefined;
  }

  async deleteForThread(threadId: string): Promise<void> {
    await this.db.delete(archivedMessage).where(eq(archivedMessage.threadId, threadId));
  }
}

function stableMessageId(payload: string, seq: number): string {
  const id = extractTopLevelStringField(payload, "id");
  return id === null || id === "" ? `archived:${seq}` : id;
}

function skipWhitespace(value: string, index: number): number {
  let i = index;
  while (i < value.length && /\s/.test(value[i] ?? "")) i += 1;
  return i;
}

function readJsonString(value: string, index: number): { text: string; end: number } | null {
  if (value[index] !== '"') return null;
  let escaped = false;
  for (let i = index + 1; i < value.length; i += 1) {
    const char = value[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      try {
        return { text: JSON.parse(value.slice(index, i + 1)) as string, end: i + 1 };
      } catch {
        return null;
      }
    }
  }
  return null;
}

function skipJsonValue(value: string, index: number): number | null {
  let i = skipWhitespace(value, index);
  const first = value[i];
  if (first === '"') return readJsonString(value, i)?.end ?? null;
  if (first !== "{" && first !== "[") {
    while (i < value.length && value[i] !== "," && value[i] !== "}") i += 1;
    return i;
  }

  const stack = [first === "{" ? "}" : "]"];
  i += 1;
  while (i < value.length && stack.length > 0) {
    const char = value[i];
    if (char === '"') {
      const parsed = readJsonString(value, i);
      if (parsed === null) return null;
      i = parsed.end;
      continue;
    }
    if (char === "{" || char === "[") stack.push(char === "{" ? "}" : "]");
    if (char === stack[stack.length - 1]) stack.pop();
    i += 1;
  }
  return stack.length === 0 ? i : null;
}

function extractTopLevelStringField(payload: string, field: string): string | null {
  let i = skipWhitespace(payload, 0);
  if (payload[i] !== "{") return null;
  i += 1;

  while (i < payload.length) {
    i = skipWhitespace(payload, i);
    if (payload[i] === "}") return null;
    const key = readJsonString(payload, i);
    if (key === null) return null;
    i = skipWhitespace(payload, key.end);
    if (payload[i] !== ":") return null;
    i = skipWhitespace(payload, i + 1);
    if (key.text === field) {
      const value = readJsonString(payload, i);
      return value?.text ?? null;
    }
    const next = skipJsonValue(payload, i);
    if (next === null) return null;
    i = skipWhitespace(payload, next);
    if (payload[i] === ",") {
      i += 1;
      continue;
    }
    if (payload[i] === "}") return null;
    return null;
  }
  return null;
}
