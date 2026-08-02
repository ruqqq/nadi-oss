/**
 * Per-thread record of how long each tool call took, in DO SQLite.
 *
 * The row is written BEFORE the tool runs and stamped when it returns. That
 * ordering is the whole point: a call that never returns — the case that cost
 * several rounds of guesswork on thr_23d415d9 — leaves an open row carrying a
 * start time, which is the only evidence such a call ever produces. A
 * completion-only record would show nothing at all for precisely the failure
 * worth investigating.
 *
 * This store is the FORENSIC record, read through `/api/debug/tool-timing`. The
 * UI does not read it: durations reach the transcript stamped onto the message
 * part itself (see `stampToolCallDurations`), because a side table cannot
 * survive archiving — an archived thread serves history from the D1 snapshot
 * and never touches this Durable Object.
 */

const TOOL_CALL_TIMING_SCHEMA = "tool_call_timing";
const TOOL_CALL_TIMING_SCHEMA_VERSION = 1;

/**
 * Rows retained per thread, trimmed on write. A starting point, not a tuned
 * number: the UI never reads this table, so trimming can only ever cost
 * forensic depth on a very long thread.
 */
export const TOOL_CALL_TIMING_RETENTION = 500;

export interface ToolCallTimingRow {
  toolCallId: string;
  toolName: string;
  startedAt: number;
  /** `null` while the call is still open — or forever, if it never returned. */
  finishedAt: number | null;
  /** `null` while open; otherwise whether `execute` returned rather than threw. */
  ok: boolean | null;
  /** Convenience for readers; `null` while open. */
  durationMs: number | null;
}

interface RawRow extends Record<string, SqlStorageValue> {
  tool_call_id: string;
  tool_name: string;
  started_at: number;
  finished_at: number | null;
  ok: number | null;
}

export class ToolCallTimingStore {
  constructor(private readonly storage: DurableObjectStorage) {}

  migrate(): void {
    this.storage.transactionSync(() => {
      this.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS tool_call_timing_schema (
          name text primary key,
          version integer not null
        )
      `);
      this.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS tool_call_timing (
          tool_call_id text primary key,
          tool_name text not null,
          started_at integer not null,
          finished_at integer,
          ok integer
        )
      `);
      this.storage.sql.exec(
        `INSERT INTO tool_call_timing_schema (name, version) VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET version = excluded.version`,
        TOOL_CALL_TIMING_SCHEMA,
        TOOL_CALL_TIMING_SCHEMA_VERSION,
      );
    });
  }

  /**
   * Open a row for a call about to run.
   *
   * `ON CONFLICT ... DO UPDATE` rather than `DO NOTHING`: a retried call reusing
   * a tool call id should be timed from its latest start, and re-opening clears
   * any stale terminal so a retry is never read as already finished.
   */
  start(input: { toolCallId: string; toolName: string; startedAt: number }): void {
    this.storage.sql.exec(
      `INSERT INTO tool_call_timing (tool_call_id, tool_name, started_at, finished_at, ok)
       VALUES (?, ?, ?, NULL, NULL)
       ON CONFLICT(tool_call_id) DO UPDATE SET
         tool_name = excluded.tool_name,
         started_at = excluded.started_at,
         finished_at = NULL,
         ok = NULL`,
      input.toolCallId,
      input.toolName,
      input.startedAt,
    );
    this.trim();
  }

  /**
   * Stamp a completed call. Only ever closes an OPEN row: `finished_at IS NULL`
   * in the WHERE clause keeps a late duplicate from rewriting a terminal that
   * was already recorded.
   */
  finish(input: { toolCallId: string; finishedAt: number; ok: boolean }): void {
    this.storage.sql.exec(
      `UPDATE tool_call_timing SET finished_at = ?, ok = ?
       WHERE tool_call_id = ? AND finished_at IS NULL`,
      input.finishedAt,
      input.ok ? 1 : 0,
      input.toolCallId,
    );
  }

  /** Every retained row, newest start first. Open rows included — they are the point. */
  list(limit = TOOL_CALL_TIMING_RETENTION): ToolCallTimingRow[] {
    return this.storage.sql
      .exec<RawRow>(
        `SELECT tool_call_id, tool_name, started_at, finished_at, ok
         FROM tool_call_timing ORDER BY started_at DESC LIMIT ?`,
        limit,
      )
      .toArray()
      .map(toRow);
  }

  /**
   * Durations for a set of tool call ids, for stamping onto message parts.
   * Open calls are omitted rather than reported as zero — "not finished" and
   * "finished instantly" must never render the same.
   */
  durationsFor(toolCallIds: string[]): Map<string, number> {
    const durations = new Map<string, number>();
    if (toolCallIds.length === 0) return durations;
    const placeholders = toolCallIds.map(() => "?").join(", ");
    const rows = this.storage.sql
      .exec<RawRow>(
        `SELECT tool_call_id, tool_name, started_at, finished_at, ok
         FROM tool_call_timing
         WHERE tool_call_id IN (${placeholders}) AND finished_at IS NOT NULL`,
        ...toolCallIds,
      )
      .toArray();
    for (const row of rows) {
      durations.set(row.tool_call_id, Math.max(0, row.finished_at! - row.started_at));
    }
    return durations;
  }

  /** Keep the newest `TOOL_CALL_TIMING_RETENTION` rows by start time. */
  private trim(): void {
    this.storage.sql.exec(
      `DELETE FROM tool_call_timing WHERE tool_call_id NOT IN (
         SELECT tool_call_id FROM tool_call_timing ORDER BY started_at DESC LIMIT ?
       )`,
      TOOL_CALL_TIMING_RETENTION,
    );
  }
}

function toRow(row: RawRow): ToolCallTimingRow {
  return {
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    ok: row.ok === null ? null : row.ok === 1,
    durationMs: row.finished_at === null ? null : Math.max(0, row.finished_at - row.started_at),
  };
}
