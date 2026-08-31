import type { UIMessage } from "ai";

// Durable queue of messages to inject into a thread's next model step. Knows
// nothing about turns or watchers — just a deduped FIFO of UIMessages. Consumed
// by ThinkThreadAgent's deliverInjection router + beforeStep drain (see
// docs/superpowers/specs/2026-07-07-mid-turn-steering-injection-design.md).

export type InjectionKind = "watcher-completion" | "subagent-completion" | "user-message";

export interface InjectionEntry {
  kind: InjectionKind;
  message: UIMessage;
}

export interface PeekedInjection extends InjectionEntry {
  seq: number;
}

export interface InjectionBufferLike {
  /** Existence-check + INSERT; returns false if the dedupe key already existed. */
  enqueue(entry: {
    dedupeKey: string;
    kind: InjectionKind;
    message: UIMessage;
    now: number;
  }): boolean;
  /** SELECT (seq order), NO delete. Callers must persist before deleting (see
   * `deleteDrained`) so a crash between peek and persist leaves the entry
   * intact for the next drain to retry. */
  peekAll(): PeekedInjection[];
  /** DELETE the rows with the given seqs. No-op if `seqs` is empty. Call this
   * ONLY after the peeked messages have been durably persisted (e.g. via
   * `addMessages`/`submitMessages`), never before. */
  deleteDrained(seqs: number[]): void;
  /** dedupeKeys of still-pending entries of `kind`, in seq order. Backs the
   * client's steer-status poll: a key present = not yet drained. */
  pendingKeys(kind: InjectionKind): string[];
  /** Remove the still-pending entry with this dedupeKey and return its message
   * (so the caller can restore composer text), or null if none is pending —
   * already drained into a turn, or never enqueued. Server-authoritative cancel.
   * When `kind` is given, only removes an entry of that kind (defense-in-depth so
   * a cancel can't reach a watcher/subagent entry that shares a key). */
  remove(dedupeKey: string, kind?: InjectionKind): UIMessage | null;
  isEmpty(): boolean;
}

interface PendingInjectionRow extends Record<string, string | number | null> {
  seq: number;
  kind: string;
  message_json: string;
}

export class InjectionBuffer implements InjectionBufferLike {
  constructor(private readonly storage: DurableObjectStorage) {}

  migrate(): void {
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS pending_injections (
        seq          integer primary key autoincrement,
        dedupe_key   text unique,
        kind         text not null,
        message_json text not null,
        enqueued_at  integer not null
      )
    `);
  }

  enqueue(entry: {
    dedupeKey: string;
    kind: InjectionKind;
    message: UIMessage;
    now: number;
  }): boolean {
    // Explicit existence check + plain INSERT rather than INSERT OR IGNORE +
    // .rowsWritten: DO SQLite's rowsWritten does NOT report 0 for an ignored
    // INSERT OR IGNORE conflict, so it can't distinguish inserted from deduped.
    // The DO is single-threaded, so there is no check-then-insert race.
    const exists =
      this.storage.sql
        .exec("SELECT 1 FROM pending_injections WHERE dedupe_key = ? LIMIT 1", entry.dedupeKey)
        .toArray().length > 0;
    if (exists) return false;
    this.storage.sql.exec(
      "INSERT INTO pending_injections (dedupe_key, kind, message_json, enqueued_at) VALUES (?, ?, ?, ?)",
      entry.dedupeKey,
      entry.kind,
      JSON.stringify(entry.message),
      entry.now,
    );
    return true;
  }

  peekAll(): PeekedInjection[] {
    const rows = this.storage.sql
      .exec<PendingInjectionRow>(
        "SELECT seq, kind, message_json FROM pending_injections ORDER BY seq ASC",
      )
      .toArray();
    return rows.map((r) => ({
      seq: r.seq,
      kind: r.kind as InjectionKind,
      message: JSON.parse(r.message_json) as UIMessage,
    }));
  }

  deleteDrained(seqs: number[]): void {
    if (seqs.length === 0) return;
    const placeholders = seqs.map(() => "?").join(", ");
    this.storage.sql.exec(`DELETE FROM pending_injections WHERE seq IN (${placeholders})`, ...seqs);
  }

  pendingKeys(kind: InjectionKind): string[] {
    return this.storage.sql
      .exec<{ dedupe_key: string }>(
        "SELECT dedupe_key FROM pending_injections WHERE kind = ? ORDER BY seq ASC",
        kind,
      )
      .toArray()
      .map((r) => r.dedupe_key);
  }

  remove(dedupeKey: string, kind?: InjectionKind): UIMessage | null {
    const row = this.storage.sql
      .exec<{ message_json: string; kind: string }>(
        "SELECT message_json, kind FROM pending_injections WHERE dedupe_key = ? LIMIT 1",
        dedupeKey,
      )
      .toArray()[0];
    if (!row) return null;
    if (kind !== undefined && row.kind !== kind) return null;
    this.storage.sql.exec("DELETE FROM pending_injections WHERE dedupe_key = ?", dedupeKey);
    return JSON.parse(row.message_json) as UIMessage;
  }

  isEmpty(): boolean {
    return this.storage.sql.exec("SELECT 1 FROM pending_injections LIMIT 1").toArray().length === 0;
  }
}

export function createMemoryInjectionBuffer(): InjectionBufferLike {
  const rows: (PeekedInjection & { dedupeKey: string })[] = [];
  let seq = 0;
  return {
    enqueue(entry) {
      if (rows.some((r) => r.dedupeKey === entry.dedupeKey)) return false;
      rows.push({
        seq: seq++,
        kind: entry.kind,
        message: entry.message,
        dedupeKey: entry.dedupeKey,
      });
      return true;
    },
    peekAll() {
      return rows.map((r) => ({ seq: r.seq, kind: r.kind, message: r.message }));
    },
    deleteDrained(seqs) {
      if (seqs.length === 0) return;
      const toDelete = new Set(seqs);
      const remaining = rows.filter((r) => !toDelete.has(r.seq));
      rows.length = 0;
      rows.push(...remaining);
    },
    pendingKeys(kind) {
      return rows.filter((r) => r.kind === kind).map((r) => r.dedupeKey);
    },
    remove(dedupeKey, kind) {
      const idx = rows.findIndex((r) => r.dedupeKey === dedupeKey);
      if (idx === -1) return null;
      if (kind !== undefined && rows[idx]?.kind !== kind) return null;
      const [removed] = rows.splice(idx, 1);
      return removed?.message ?? null;
    },
    isEmpty() {
      return rows.length === 0;
    },
  };
}
