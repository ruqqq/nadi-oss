import type { RegistrySqlStorage } from "./registry-migrations";

/** Result rows plus D1-shaped meta for one statement. Mirrors D1Result. */
export interface RegistryAllResult {
  results: Record<string, SqlStorageValue>[];
  success: true;
  meta: D1Meta;
}

export interface RegistryBatchItem {
  sql: string;
  params: unknown[];
}

export function toSqlStorageValue(value: unknown): SqlStorageValue {
  // D1 accepts booleans and stores them as 1/0; SqlStorage bind values are
  // string | number | null | ArrayBuffer, so coerce before binding.
  if (typeof value === "boolean") return value ? 1 : 0;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value)
  ) {
    return value as SqlStorageValue;
  }
  // Anything else (undefined, objects, symbols, functions) is not bindable.
  // Say so here rather than letting it reach SqlStorage, which reports it as a
  // cryptic bind failure — and, over a Durable Object RPC boundary, also as a
  // phantom unhandled rejection that no caller can catch.
  throw new Error(
    `registry: cannot bind a ${value === undefined ? "undefined" : typeof value} parameter`,
  );
}

/**
 * The transactional core of `execBatch`, extracted so it can be tested without
 * a Durable Object. It cannot be covered through the DO: workerd reports *any*
 * throw inside an RPC method as an unhandled rejection in addition to rejecting
 * the call, and vitest fails the whole run on that even when the caller awaits
 * it — so the rollback path is unassertable across that boundary.
 */
export function runRegistryBatch(
  storage: RegistrySqlStorage,
  statements: RegistryBatchItem[],
  meta: (cursor: SqlStorageCursor<Record<string, SqlStorageValue>>, start: number) => D1Meta,
): RegistryAllResult[] {
  const results: RegistryAllResult[] = [];
  storage.transactionSync(() => {
    for (const statement of statements) {
      const start = performance.now();
      const cursor = storage.sql.exec(statement.sql, ...statement.params.map(toSqlStorageValue));
      results.push({ results: cursor.toArray(), success: true, meta: meta(cursor, start) });
    }
  });
  return results;
}
