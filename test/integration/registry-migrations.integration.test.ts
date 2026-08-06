import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import type { RegistryDatabase } from "../../src/db/registry-do";
import { RegistryMigrationsError, runRegistryMigrations } from "../../src/db/registry-migrations";

// TEST-ONLY binding (see vitest.config.ts): the celld registry DO exists in
// the pool so the facade and migration behavior can be exercised on the
// Cloudflare side. REGISTRY_DO is declared on src/env.ts's Env (optional,
// celld-only), so cast the pool env to that type instead of augmenting
// Cloudflare.Env.
const poolEnv = env as unknown as Env;

function freshRegistry(name: string): DurableObjectStub<RegistryDatabase> {
  return poolEnv.REGISTRY_DO!.get(
    poolEnv.REGISTRY_DO!.idFromName(`reg_migrations_${name}_${crypto.randomUUID()}`),
  );
}

async function appliedCount(stub: DurableObjectStub<RegistryDatabase>): Promise<number> {
  const result = (await stub.exec(
    "SELECT count(*) AS c FROM __drizzle_migrations",
    [],
    "all",
  )) as unknown as { results: { c: number }[] };
  return result.results[0]?.c ?? -1;
}

async function tableNames(stub: DurableObjectStub<RegistryDatabase>): Promise<string[]> {
  const result = (await stub.exec(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    [],
    "all",
  )) as unknown as { results: { name: string }[] };
  return result.results.map((row) => row.name);
}

describe("RegistryDatabase boot migrations", () => {
  it("applies the bundled migrations to an empty database: empty → head", async () => {
    // First RPC cold-starts the DO, which runs the bundled migrations in the
    // constructor before serving anything.
    const stub = freshRegistry("head");
    const tables = await tableNames(stub);
    expect(tables).toContain("__drizzle_migrations");
    // First migration's table and the latest migration's table both exist.
    expect(tables).toContain("users");
    expect(tables).toContain("provider_configs");
    // The FTS5 virtual table from migration 0052 applied (workerd SQLite
    // ships FTS5 — this is the riskiest statement in the bundle).
    expect(tables).toContain("thread_search_fts");
    expect(await appliedCount(stub)).toBe(60);
  });

  it("re-running the migrations is a no-op", async () => {
    const stub = freshRegistry("noop");
    await stub.exec("SELECT 1", [], "all"); // boot
    const before = await appliedCount(stub);
    await runInDurableObject(stub, async (_instance, state) => {
      await runRegistryMigrations(state.storage);
      await runRegistryMigrations(state.storage);
    });
    expect(await appliedCount(stub)).toBe(before);
    expect(before).toBe(60);
  });

  it("a registry migrated by a different bundle fails loudly instead of skipping", async () => {
    const stub = freshRegistry("gap");
    await stub.exec("SELECT 1", [], "all"); // boot to head
    await runInDurableObject(stub, async (_instance, state) => {
      // Simulate a history that diverges from this bundle: the last applied
      // migration's recorded timestamp matches no journal entry (as if a
      // migration had been dropped from the bundle after the fact).
      state.storage.sql.exec(
        "UPDATE __drizzle_migrations SET created_at = 999999999999 WHERE created_at = (SELECT MAX(created_at) FROM __drizzle_migrations)",
      );
      await expect(runRegistryMigrations(state.storage)).rejects.toThrow(RegistryMigrationsError);
    });
  });

  it("a registry missing a middle migration from its applied history fails loudly", async () => {
    const stub = freshRegistry("missing-middle");
    await stub.exec("SELECT 1", [], "all"); // boot to head
    await runInDurableObject(stub, async (_instance, state) => {
      // Delete the 30th applied migration: the remaining set is no longer a
      // prefix of the journal, which is exactly the state a registry lands in
      // when it was migrated with a bundle that skipped a migration.
      state.storage.sql.exec(
        "DELETE FROM __drizzle_migrations WHERE created_at = (SELECT created_at FROM __drizzle_migrations ORDER BY created_at LIMIT 1 OFFSET 30)",
      );
      await expect(runRegistryMigrations(state.storage)).rejects.toThrow(RegistryMigrationsError);
    });
  });

  it("execBatch applies the whole batch atomically", async () => {
    const stub = freshRegistry("batch-atomicity");
    await stub.exec("CREATE TABLE IF NOT EXISTS batch_probe (a INTEGER)", [], "run");
    // First a clean batch: both statements land.
    await stub.execBatch([
      { sql: "INSERT INTO batch_probe (a) VALUES (1)", params: [] },
      { sql: "INSERT INTO batch_probe (a) VALUES (2)", params: [] },
    ]);
    const rows = (await stub.exec(
      "SELECT a FROM batch_probe ORDER BY a",
      [],
      "all",
    )) as unknown as {
      results: { a: number }[];
    };
    expect(rows.results.map((r) => r.a)).toEqual([1, 2]);

    // Then a batch whose second statement violates a constraint: the first
    // statement must roll back with it.
    await stub.exec("CREATE TABLE IF NOT EXISTS batch_probe_u (a INTEGER UNIQUE)", [], "run");
    await stub.execBatch([{ sql: "INSERT INTO batch_probe_u (a) VALUES (1)", params: [] }]);
    await expect(
      stub.execBatch([
        { sql: "INSERT INTO batch_probe_u (a) VALUES (2)", params: [] },
        { sql: "INSERT INTO batch_probe_u (a) VALUES (1)", params: [] },
      ]),
    ).rejects.toThrow();
    const after = (await stub.exec("SELECT a FROM batch_probe_u", [], "all")) as unknown as {
      results: { a: number }[];
    };
    expect(after.results.map((r) => r.a)).toEqual([1]);
  });
});
