import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { assertNotTransactionControl } from "./registry-d1";
import { runRegistryMigrations } from "./registry-migrations";
import { runRegistryBatch, toSqlStorageValue } from "./registry-batch";

export {
  runRegistryBatch,
  toSqlStorageValue,
  type RegistryAllResult,
  type RegistryBatchItem,
} from "./registry-batch";
import type { RegistryAllResult, RegistryBatchItem } from "./registry-batch";

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
 *
 * The celld edition also keeps workspace secrets here: `kvGet`/`kvPut`/
 * `kvDelete`/`kvList` serve the KVNamespace-shaped `RegistryKV` facade over a
 * DO-private `__celld_kv` table created at boot (see ensureCelldKvTable).
 * Values are opaque text (already AES-GCM ciphertext) — the table stores them
 * verbatim and the facade owns all KV semantics, including rejecting options
 * that would change them (expiration/expirationTtl/metadata).
 */

export interface RegistryRunResult {
  success: true;
  meta: D1Meta;
}

export interface RegistryRawResult {
  columnNames: string[];
  rows: SqlStorageValue[][];
}

/** One page of `kvList` results, shaped like a real KV `list()` page. */
export interface RegistryKvListPage {
  keys: { name: string }[];
  list_complete: boolean;
  /** Present only when `list_complete` is false; opaque to the facade. */
  cursor: string | null;
  cacheStatus: string | null;
}

export interface RegistryKvListRequest {
  prefix: string;
  limit: number;
  cursor: string | null;
}

/** The celld-only KV table. Created by the DO at boot, never a migration:
 *  it is DO-private storage, not part of the shared Cloudflare schema. */
const CELLD_KV_TABLE_DDL = `CREATE TABLE IF NOT EXISTS __celld_kv (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
)`;

/** KV lists keys in lexicographic byte order; the default/maximum page size
 *  mirrors real KV (1000). */
const KV_LIST_DEFAULT_LIMIT = 1000;
/** U+10FFFF — the largest valid UTF-8 code point. `prefix + this` is the
 *  bytewise upper bound for "keys starting with `prefix`" under SQLite's
 *  BINARY collation. Edge note: a key whose first code point after `prefix`
 *  is exactly U+10FFFF sorts at the bound and is excluded — unreachable for
 *  secrets keys (ASCII `workspaces/<id>/secrets/<name>`), so the cheaper
 *  range bound wins over a LIKE-based predicate (LIKE is ASCII-case-insensitive
 *  in SQLite, which would break key ordering). */
const KV_LIST_PREFIX_CEILING = "\u{10FFFF}";

/** Encode the pagination state into the opaque cursor string the facade hands
 *  back verbatim: the prefix the page belongs to plus the last key returned,
 *  so a cursor is only ever applied to the query that produced it. */
function encodeKvCursor(prefix: string, lastKey: string): string {
  const json = JSON.stringify({ p: prefix, k: lastKey });
  let binary = "";
  for (const byte of new TextEncoder().encode(json)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeKvCursor(cursor: string): { p: string; k: string } | null {
  try {
    const binary = atob(cursor);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes)) as { p: string; k: string };
  } catch {
    return null;
  }
}

export class RegistryDatabase extends DurableObject<Env> {
  private migrationError: unknown = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      try {
        await runRegistryMigrations(this.ctx.storage);
        ensureCelldKvTable(this.ctx.storage.sql);
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
    return runRegistryBatch(this.ctx.storage, statements, (cursor, start) =>
      this.metaFor(cursor, false, start),
    );
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

  async kvGet(key: string): Promise<string | null> {
    this.throwIfMigrationFailed();
    const row = this.ctx.storage.sql
      .exec("SELECT value FROM __celld_kv WHERE key = ?", key)
      .toArray()[0];
    return row ? (row.value as string) : null;
  }

  async kvPut(key: string, value: string): Promise<void> {
    this.throwIfMigrationFailed();
    this.ctx.storage.sql.exec(
      "INSERT INTO __celld_kv (key, value) VALUES (?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  async kvDelete(key: string): Promise<void> {
    this.throwIfMigrationFailed();
    this.ctx.storage.sql.exec("DELETE FROM __celld_kv WHERE key = ?", key);
  }

  async kvList(request: RegistryKvListRequest): Promise<RegistryKvListPage> {
    this.throwIfMigrationFailed();
    const { prefix, cursor } = request;
    const limit = Math.min(Math.max(request.limit, 1), KV_LIST_DEFAULT_LIMIT);
    const after = cursor === null ? null : decodeKvCursor(cursor);
    if (cursor !== null && after === null) {
      throw new Error("RegistryKV list: malformed cursor");
    }
    if (after !== null && after.p !== prefix) {
      throw new Error(
        "RegistryKV list: cursor was issued for a different prefix; refusing to apply it",
      );
    }
    // `prefix + U+10FFFF` is the bytewise upper bound for "keys starting with
    // `prefix`" under SQLite's BINARY collation (the same order KV lists keys
    // in).
    const params: SqlStorageValue[] = [prefix, prefix + KV_LIST_PREFIX_CEILING];
    let sql = "SELECT key FROM __celld_kv WHERE key >= ? AND key < ?";
    if (after) {
      sql += " AND key > ?";
      params.push(after.k);
    }
    // Fetch one row past the page so `list_complete` reflects the namespace,
    // not just the page (a facade that always says complete silently
    // truncates for callers that loop on the cursor).
    sql += " ORDER BY key LIMIT ?";
    params.push(limit + 1);
    const keys = this.ctx.storage.sql
      .exec(sql, ...params)
      .toArray()
      .map((row) => row.key as string);
    const page = keys.slice(0, limit);
    const hasMore = keys.length > limit;
    return {
      keys: page.map((name) => ({ name })),
      list_complete: !hasMore,
      cursor: hasMore ? encodeKvCursor(prefix, page[page.length - 1]!) : null,
      cacheStatus: null,
    };
  }
}

function ensureCelldKvTable(storage: SqlStorage): void {
  storage.exec(CELLD_KV_TABLE_DDL);
}
