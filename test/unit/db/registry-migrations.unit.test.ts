import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { runRegistryBatch } from "../../../src/db/registry-batch";
import {
  RegistryMigrationsError,
  registryMigrationBundle,
  runRegistryMigrations,
  type RegistryMigrationBundle,
  type RegistrySqlStorage,
} from "../../../src/db/registry-migrations";

// node:sqlite's own type declarations are picked up by this repo's typecheck
// (tsgo ships node module types); no shim needed here.

interface FakeCursor {
  toArray(): Record<string, unknown>[];
  next(): { value: Record<string, unknown> | undefined; done: boolean };
  [Symbol.iterator](): Iterator<Record<string, unknown>>;
  raw(): { toArray(): unknown[][] };
  one(): Record<string, unknown> | undefined;
  columnNames: string[];
  rowsRead: number;
  rowsWritten: number;
}

function makeCursor(rows: Record<string, unknown>[], columnNames: string[]): FakeCursor {
  let index = 0;
  return {
    toArray: () => rows,
    next: () => {
      const row = rows[index];
      if (row === undefined) return { value: undefined, done: true };
      index++;
      return { value: row, done: false };
    },
    [Symbol.iterator]() {
      return rows[Symbol.iterator]();
    },
    raw: () => ({ toArray: () => rows.map((row) => Object.values(row)) }),
    one: () => rows[0],
    columnNames,
    rowsRead: rows.length,
    rowsWritten: 0,
  };
}

/** True when the SQL contains more than one top-level statement. workerd's
 *  SqlStorage (and D1's batch path) execute such strings whole; node:sqlite's
 *  prepare() would silently run only the first, so the fake must route them to
 *  exec() like the real runtime does. */
function isMultiStatement(sql: string): boolean {
  let quote: "'" | '"' | "`" | null = null;
  let statements = 0;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      if (ch === quote && sql[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i++;
      continue;
    }
    if (ch === ";") statements++;
  }
  return statements > 1;
}

/** A real SQLite-backed RegistrySqlStorage, so the migrator's SQL actually
 *  executes (multi-statement DDL, transactions, PRAGMAs, FTS5 included). */
function createStorage(): { storage: RegistrySqlStorage; db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  const storage: RegistrySqlStorage = {
    sql: {
      exec(query: string, ...params: unknown[]): FakeCursor {
        if (params.length > 0) {
          const stmt = db.prepare(query);
          const columns = stmt.columns();
          if (columns.length > 0) {
            return makeCursor(
              stmt.all(...(params as SQLInputValue[])),
              columns.map((c) => c.name),
            );
          }
          stmt.run(...(params as SQLInputValue[]));
          return makeCursor([], []);
        }
        // workerd/D1 execute multi-statement strings whole; node:sqlite's
        // prepare() would silently drop everything after the first `;`.
        if (isMultiStatement(query)) {
          db.exec(query);
          return makeCursor([], []);
        }
        const stmt = db.prepare(query);
        const columns = stmt.columns();
        if (columns.length > 0) {
          return makeCursor(
            stmt.all(),
            columns.map((c) => c.name),
          );
        }
        stmt.run();
        return makeCursor([], []);
      },
    } as unknown as SqlStorage,
    transactionSync: <T>(closure: () => T) => {
      db.exec("BEGIN");
      try {
        const result = closure();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { storage, db };
}

function countRows(db: DatabaseSync, table: string): number {
  return db.prepare(`SELECT count(*) AS c FROM ${table}`).all()[0]?.c as number;
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return (
    (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").all(name)[0] as
      | { name?: string }
      | undefined) !== undefined
  );
}

describe("runRegistryMigrations", () => {
  it("applies the bundled migrations to an empty registry", async () => {
    const { storage, db } = createStorage();
    await runRegistryMigrations(storage);
    expect(countRows(db, "__drizzle_migrations")).toBe(
      registryMigrationBundle.journal.entries.length,
    );
    // A table from the first migration and one from the last both exist.
    expect(tableExists(db, "users")).toBe(true);
    expect(tableExists(db, "thread_search_fts")).toBe(true);
  });

  it("re-running against an up-to-date registry is a no-op", async () => {
    const { storage, db } = createStorage();
    await runRegistryMigrations(storage);
    const before = countRows(db, "__drizzle_migrations");
    await runRegistryMigrations(storage);
    await runRegistryMigrations(storage);
    expect(countRows(db, "__drizzle_migrations")).toBe(before);
  });

  it("fails loudly when an applied migration diverges from the journal", async () => {
    const { storage, db } = createStorage();
    await runRegistryMigrations(storage);
    // Simulate a registry that was migrated by a different bundle: the last
    // applied migration's recorded timestamp no longer matches any journal
    // entry (a migration was removed from this bundle's history).
    db.exec(
      "UPDATE __drizzle_migrations SET created_at = 999999999999 WHERE created_at = (SELECT MAX(created_at) FROM __drizzle_migrations)",
    );
    await expect(runRegistryMigrations(storage)).rejects.toThrow(RegistryMigrationsError);
  });

  it("fails loudly when an applied migration is missing from the middle", async () => {
    const { storage, db } = createStorage();
    await runRegistryMigrations(storage);
    // The registry was migrated with migration #30 present, but this bundle's
    // applied history no longer has it — the prefix no longer lines up.
    db.exec(
      "DELETE FROM __drizzle_migrations WHERE created_at = (SELECT created_at FROM __drizzle_migrations ORDER BY created_at LIMIT 1 OFFSET 30)",
    );
    await expect(runRegistryMigrations(storage)).rejects.toThrow(RegistryMigrationsError);
  });

  it("fails loudly when the bundle is missing migrations the registry already applied", async () => {
    const { storage, db } = createStorage();
    const bundle: RegistryMigrationBundle = {
      journal: {
        entries: registryMigrationBundle.journal.entries.filter((e) => e.idx < 59),
      },
      migrations: Object.fromEntries(
        Object.entries(registryMigrationBundle.migrations).filter(([key]) => key !== "m0059"),
      ),
    };
    await runRegistryMigrations(storage, bundle);
    // The registry is now at bundle-head (59), but the real bundle has one
    // more migration: applying it is the normal forward path.
    await runRegistryMigrations(storage);
    expect(countRows(db, "__drizzle_migrations")).toBe(60);
    // ...and a bundle that cannot see an applied migration fails loudly.
    await expect(runRegistryMigrations(storage, bundle)).rejects.toThrow(RegistryMigrationsError);
  });
});

describe("runRegistryBatch", () => {
  it("rolls the whole batch back when a statement fails", () => {
    const { storage, db } = createStorage();
    storage.sql.exec("CREATE TABLE batch_probe (a INTEGER)");
    const meta = () => ({ duration: 0, changes: 0, last_row_id: 0 }) as never;

    // A clean batch lands.
    runRegistryBatch(
      storage,
      [
        { sql: "INSERT INTO batch_probe (a) VALUES (1)", params: [] },
        { sql: "INSERT INTO batch_probe (a) VALUES (2)", params: [] },
      ],
      meta,
    );
    expect(countRows(db, "batch_probe")).toBe(2);

    // A batch whose second statement fails takes the first down with it.
    expect(() =>
      runRegistryBatch(
        storage,
        [
          { sql: "INSERT INTO batch_probe (a) VALUES (3)", params: [] },
          { sql: "INSERT INTO batch_probe (a) VALUES (?)", params: [{ not: "bindable" }] },
        ],
        meta,
      ),
    ).toThrow(/cannot bind an? object parameter/);
    expect(countRows(db, "batch_probe")).toBe(2);
  });

  it("refuses parameters SqlStorage cannot bind", () => {
    const { storage } = createStorage();
    storage.sql.exec("CREATE TABLE p (a INTEGER)");
    expect(() =>
      runRegistryBatch(
        storage,
        [{ sql: "INSERT INTO p (a) VALUES (?)", params: [undefined] }],
        () => ({ duration: 0, changes: 0, last_row_id: 0 }) as never,
      ),
    ).toThrow(/cannot bind an? undefined parameter/);
  });
});
