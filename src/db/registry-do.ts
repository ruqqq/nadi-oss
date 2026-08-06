import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { assertNotTransactionControl } from "./registry-d1";
import { runRegistryMigrations } from "./registry-migrations";

/**
 * The celld registry: a single Durable Object holding the whole registry
 * database in its SQL storage, reachable through the D1-shaped `RegistryD1`
 * facade (see registry-d1.ts).
 *
 * The bundled migrations (generated from `migrations/` by
 * scripts/bundle-celld-migrations.mjs) are applied in the constructor inside
 * `ctx.blockConcurrencyWhile`, so no RPC is served before the schema is
 * ready, and a boot that cannot reach a coherent applied state fails loudly on
 * every subsequent call instead of serving against a wrong schema.
 *
 * RPC surface, deliberately small: `exec(sql, params, mode)` for single
 * statements and `execBatch(statements)` for the whole-array-in-one-transaction
 * path `batch()` needs. Everything else (bind, first, raw, exec multi-
 * statement, D1 result/meta shapes) is facade-side.
 */

export interface RegistryAllResult {
  results: Record<string, SqlStorageValue>[];
  success: true;
  meta: D1Meta;
}

export interface RegistryRunResult {
  success: true;
  meta: D1Meta;
}

export interface RegistryRawResult {
  columnNames: string[];
  rows: SqlStorageValue[][];
}

export interface RegistryBatchItem {
  sql: string;
  params: unknown[];
}

function toSqlStorageValue(value: unknown): SqlStorageValue {
  // D1 accepts booleans and stores them as 1/0; SqlStorage bind values are
  // string | number | null | ArrayBuffer, so coerce before binding.
  if (typeof value === "boolean") return value ? 1 : 0;
  return value as SqlStorageValue;
}

export class RegistryDatabase extends DurableObject<Env> {
  private migrationError: unknown = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      try {
        await runRegistryMigrations(this.ctx.storage);
      } catch (error) {
        this.migrationError = error;
      }
    });
  }

  async exec(
    sql: string,
    params: unknown[],
    mode: "all" | "run" | "raw",
  ): Promise<RegistryAllResult | RegistryRunResult | RegistryRawResult> {
    this.throwIfMigrationFailed();
    assertNotTransactionControl(sql);
    const storage = this.ctx.storage.sql;
    const start = performance.now();
    const cursor = storage.exec(sql, ...params.map(toSqlStorageValue));
    if (mode === "raw") {
      return {
        columnNames: cursor.columnNames,
        rows: Array.from(cursor.raw<SqlStorageValue[]>()),
      };
    }
    const rows = cursor.toArray();
    const meta = this.metaFor(cursor, mode === "run", start);
    if (mode === "run") return { success: true, meta };
    return { results: rows, success: true, meta };
  }

  async execBatch(statements: RegistryBatchItem[]): Promise<RegistryAllResult[]> {
    this.throwIfMigrationFailed();
    for (const statement of statements) assertNotTransactionControl(statement.sql);
    const results: RegistryAllResult[] = [];
    this.ctx.storage.transactionSync(() => {
      const storage = this.ctx.storage.sql;
      for (const statement of statements) {
        const start = performance.now();
        const cursor = storage.exec(statement.sql, ...statement.params.map(toSqlStorageValue));
        results.push({
          results: cursor.toArray(),
          success: true,
          meta: this.metaFor(cursor, false, start),
        });
      }
    });
    return results;
  }

  /** The workerd SqlStorage cursor exposes no query meta, so `changes` and
   *  `last_row_id` come from a follow-up SELECT (single-threaded per instance,
   *  synchronous between the two statements — no interleaving). Only run-mode
   *  statements pay for it: those are the only consumers of `changes` (e.g.
   *  container-ledger, invites). Read paths report cursor-observed counts. */
  private metaFor(
    cursor: SqlStorageCursor<Record<string, SqlStorageValue>>,
    includeWriteMeta: boolean,
    start: number,
  ): D1Meta {
    let changes = 0;
    let lastRowId = 0;
    if (includeWriteMeta) {
      const row =
        this.ctx.storage.sql
          .exec("SELECT changes() AS changes, last_insert_rowid() AS last_row_id")
          .toArray()[0] ?? {};
      changes = typeof row.changes === "number" ? row.changes : 0;
      lastRowId = typeof row.last_row_id === "number" ? row.last_row_id : 0;
    }
    return {
      duration: performance.now() - start,
      size_after: 0,
      rows_read: cursor.rowsRead,
      rows_written: cursor.rowsWritten,
      last_row_id: lastRowId,
      changed_db: changes > 0,
      changes,
    };
  }

  private throwIfMigrationFailed(): void {
    if (this.migrationError) throw this.migrationError;
  }
}
