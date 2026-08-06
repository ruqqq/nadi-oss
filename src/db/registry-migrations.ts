import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { celldJournal, celldMigrations } from "./migrations/celld-bundle";
/**
 * The durable-sqlite migration bundle the RegistryDatabase applies at boot.
 * Generated from `migrations/` by scripts/bundle-celld-migrations.mjs (which
 * `pnpm db:generate` chains), so the SQL text is verbatim from the drizzle-kit
 * migration files — see that script.
 */
export interface RegistryMigrationBundle {
  journal: {
    entries: { idx: number; when: number; tag: string; breakpoints: boolean }[];
  };
  migrations: Record<string, string>;
}

export const registryMigrationBundle: RegistryMigrationBundle = {
  journal: celldJournal,
  migrations: celldMigrations,
};

/**
 * The storage surface the runner needs: DurableObjectStorage already satisfies
 * it (SqlStorage for statements, transactionSync for the migrator's all-or-
 * nothing apply), and tests can fake it with a plain object.
 */
export interface RegistrySqlStorage {
  sql: SqlStorage;
  transactionSync<T>(closure: () => T): T;
}

export class RegistryMigrationsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryMigrationsError";
  }
}

const MIGRATIONS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS __drizzle_migrations (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	hash TEXT NOT NULL,
	created_at INTEGER NOT NULL
)`;

/**
 * Apply the bundled migrations to a registry, recording each applied migration
 * in `__drizzle_migrations` (the same table `drizzle-orm/durable-sqlite`'s
 * migrator maintains).
 *
 * Re-running is a no-op once the applied set is up to date. The applied set
 * must be a contiguous prefix of the bundle's journal: a registry migrated by
 * a different bundle (a migration added, removed or reordered in the middle)
 * fails loudly here rather than silently skipping or reordering, because
 * silently diverging schema would corrupt later slices' data.
 */
export async function runRegistryMigrations(
  storage: RegistrySqlStorage,
  bundle: RegistryMigrationBundle = registryMigrationBundle,
): Promise<void> {
  const journal = bundle.journal.entries;
  storage.sql.exec(MIGRATIONS_TABLE_DDL);
  const applied = readAppliedMigrations(storage);
  assertAppliedIsPrefix(applied, journal);
  if (applied.length === journal.length) return;
  const db = drizzle(
    // The driver's type wants a full DurableObjectStorage, but the migrator
    // only touches `sql` and `transactionSync`; the structural subset is all
    // the runtime contract needs (and lets tests fake the storage).
    storage as unknown as DurableObjectStorage,
  );
  await migrate(db, bundle);
}

function readAppliedMigrations(storage: RegistrySqlStorage): { created_at: number }[] {
  const rows = storage.sql
    .exec("SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at ASC, id ASC")
    .toArray();
  return rows.map((row) => ({ created_at: row.created_at as number }));
}

function assertAppliedIsPrefix(
  applied: { created_at: number }[],
  journal: RegistryMigrationBundle["journal"]["entries"],
): void {
  for (const [i, found] of applied.entries()) {
    const expected = journal[i];
    if (!expected) {
      throw new RegistryMigrationsError(
        `registry has ${applied.length} applied migrations but the bundled journal only ` +
          `has ${journal.length} (applied #${i} with created_at=${found.created_at}). ` +
          `The registry was migrated by a newer bundle; refusing to continue.`,
      );
    }
    if (found.created_at !== expected.when) {
      throw new RegistryMigrationsError(
        `applied migration #${i} has created_at=${found.created_at} but the bundled ` +
          `journal expects ${expected.tag} (when=${expected.when}). The registry was ` +
          `migrated by a different bundle — a migration is missing from, or reordered in, ` +
          `this bundle's history; refusing to continue. Regenerate the bundle ` +
          `(pnpm celld:db:bundle) and reconcile the registry.`,
      );
    }
  }
}
