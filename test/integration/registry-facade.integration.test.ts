import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { DrizzleQueryError } from "drizzle-orm/errors";
import * as schema from "../../src/db/schema";
import { registryBinding, registryDb } from "../../src/db/client";
import { RegistryD1 } from "../../src/db/registry-d1";
import type { Env } from "../../src/env";
import { ThreadRepository } from "../../src/db/repositories/threads";
import { AutomatonRepository } from "../../src/db/repositories/automata";
import { buildAuth } from "../../src/auth/options";
import { validateRequestSession } from "../../src/auth/session";

// TEST-ONLY: REGISTRY_DO is bound in the pool (see vitest.config.ts) so the
// celld registry facade can be exercised on the Cloudflare side.
const poolEnv = env as unknown as Env;

/** An env shaped like celld's: no REGISTRY_DB, REGISTRY_DO present. */
function celldEnv(overrides?: Partial<Env>): Env {
  return {
    ...poolEnv,
    REGISTRY_DB: undefined,
    REGISTRY_DO: poolEnv.REGISTRY_DO,
    NADI_PLATFORM: "celld",
    ...overrides,
  } as unknown as Env;
}

/** A facade over the singleton RegistryDatabase DO. */
function freshFacade(): D1Database {
  return new RegistryD1(poolEnv.REGISTRY_DO!);
}

async function execAll(
  db: D1Database,
  sql: string,
  ...params: unknown[]
): Promise<Record<string, unknown>[]> {
  const result = await db
    .prepare(sql)
    .bind(...params)
    .all<Record<string, unknown>>();
  return result.results;
}

describe("registryBinding", () => {
  it("returns the real D1 binding when REGISTRY_DB exists", () => {
    expect(registryBinding(poolEnv)).toBe(poolEnv.REGISTRY_DB);
  });

  it("returns a RegistryD1 facade when REGISTRY_DB is absent", () => {
    const binding = registryBinding(celldEnv());
    expect(binding).toBeInstanceOf(RegistryD1);
    expect(registryDb(celldEnv())).toBeDefined();
  });

  it("fails loudly when neither binding exists", () => {
    const broken = { ...poolEnv, REGISTRY_DB: undefined, REGISTRY_DO: undefined } as unknown as Env;
    expect(() => registryBinding(broken)).toThrow(/REGISTRY_DB nor REGISTRY_DO/);
  });
});

describe("RegistryD1 D1 surface", () => {
  it("prepare/bind/all returns rows as objects", async () => {
    const db = freshFacade();
    await db.exec("CREATE TABLE probe_all (id INTEGER, v TEXT)");
    await db.prepare("INSERT INTO probe_all (id, v) VALUES (?, ?)").bind(1, "one").run();
    await db.prepare("INSERT INTO probe_all (id, v) VALUES (?, ?)").bind(2, "two").run();

    const rows = await execAll(db, "SELECT id, v FROM probe_all ORDER BY id");
    expect(rows).toEqual([
      { id: 1, v: "one" },
      { id: 2, v: "two" },
    ]);
  });

  it("first() and first(col) return the first row / value, null when empty", async () => {
    const db = freshFacade();
    await db.exec("CREATE TABLE probe_first (id INTEGER, v TEXT)");
    await db.prepare("INSERT INTO probe_first (id, v) VALUES (?, ?)").bind(1, "one").run();

    await expect(db.prepare("SELECT id, v FROM probe_first ORDER BY id").first()).resolves.toEqual({
      id: 1,
      v: "one",
    });
    await expect(db.prepare("SELECT id, v FROM probe_first ORDER BY id").first("v")).resolves.toBe(
      "one",
    );
    await expect(
      db.prepare("SELECT id, v FROM probe_first WHERE id = 99").first(),
    ).resolves.toBeNull();
    await expect(
      db.prepare("SELECT id, v FROM probe_first WHERE id = 99").first("v"),
    ).resolves.toBeNull();
  });

  it("run() reports changes and last_row_id", async () => {
    const db = freshFacade();
    await db.exec("CREATE TABLE probe_run (id INTEGER PRIMARY KEY, v TEXT)");
    const result = await db.prepare("INSERT INTO probe_run (v) VALUES (?)").bind("x").run();
    expect(result.success).toBe(true);
    expect(result.meta.changes).toBe(1);
    expect(result.meta.last_row_id).toBe(1);

    const update = await db.prepare("UPDATE probe_run SET v = ? WHERE id = 1").bind("y").run();
    expect(update.meta.changes).toBe(1);
  });

  it("raw() returns rows as arrays; raw({columnNames: true}) prepends the names", async () => {
    const db = freshFacade();
    await db.exec("CREATE TABLE probe_raw (id INTEGER, v TEXT)");
    await db.prepare("INSERT INTO probe_raw (id, v) VALUES (?, ?)").bind(1, "one").run();

    await expect(db.prepare("SELECT id, v FROM probe_raw").raw()).resolves.toEqual([[1, "one"]]);
    await expect(
      db.prepare("SELECT id, v FROM probe_raw").raw({ columnNames: true }),
    ).resolves.toEqual([
      ["id", "v"],
      [1, "one"],
    ]);
  });

  it("batch() runs statements in order and makes everything visible", async () => {
    const db = freshFacade();
    await db.exec("CREATE TABLE probe_batch (id INTEGER, v TEXT)");
    const results = await db.batch([
      db.prepare("INSERT INTO probe_batch (id, v) VALUES (1, 'one')"),
      db.prepare("INSERT INTO probe_batch (id, v) VALUES (2, 'two')"),
      db.prepare("SELECT id, v FROM probe_batch ORDER BY id"),
    ]);
    expect(results).toHaveLength(3);
    expect((results[2] as { results: unknown[] }).results).toEqual([
      { id: 1, v: "one" },
      { id: 2, v: "two" },
    ]);
  });

  it("exec() runs multi-statement SQL and reports the statement count", async () => {
    const db = freshFacade();
    const result = await db.exec(
      "CREATE TABLE probe_exec (id INTEGER); INSERT INTO probe_exec VALUES (1); INSERT INTO probe_exec VALUES (2);",
    );
    expect(result.count).toBe(3);
    expect(await execAll(db, "SELECT count(*) AS c FROM probe_exec")).toEqual([{ c: 2 }]);
  });

  it("binds booleans as 1/0 like D1", async () => {
    const db = freshFacade();
    await db.exec("CREATE TABLE probe_bools (flag INTEGER)");
    await db.prepare("INSERT INTO probe_bools (flag) VALUES (?)").bind(true).run();
    await db.prepare("INSERT INTO probe_bools (flag) VALUES (?)").bind(false).run();
    expect(await execAll(db, "SELECT flag FROM probe_bools ORDER BY flag")).toEqual([
      { flag: 0 },
      { flag: 1 },
    ]);
  });
});

describe("transaction control", () => {
  it("run() of a transaction-control statement throws the D1-shaped error", async () => {
    const db = freshFacade();
    await expect(db.prepare("begin").run()).rejects.toThrow(
      /please use the state\.storage\.transaction\(\)/,
    );
    await expect(db.prepare("begin").run()).rejects.toThrow(/SQL BEGIN TRANSACTION/);
    await expect(db.prepare("commit").run()).rejects.toThrow(/SQL COMMIT/);
  });

  it("drizzle db.transaction surfaces the D1 begin error the fallback recognises", async () => {
    const db = registryDb(celldEnv());
    const error = await db
      .transaction(async (tx) => {
        await tx.select().from(schema.users).all();
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DrizzleQueryError);
    const drizzleError = error as DrizzleQueryError;
    expect(drizzleError.query).toBe("begin");
    expect(drizzleError.params).toEqual([]);
    expect(drizzleError.cause).toBeInstanceOf(Error);
    const cause = drizzleError.cause as Error;
    expect(cause.message).toContain("please use the state.storage.transaction()");
    expect(cause.message).toContain("SQL BEGIN TRANSACTION");
  });

  it("withTransactionalWrite falls back and persists despite unsupported transactions", async () => {
    // ThreadRepository.create routes through withTransactionalWrite, which
    // first tries db.transaction (begin → D1 error) and then falls back to
    // writing inline. On celld the facade must produce the exact error that
    // fallback already recognises, so create() succeeds.
    const db = registryDb(celldEnv());
    const workspaceId = `ws_tx_${crypto.randomUUID()}`;
    const agentId = `agent_tx_${crypto.randomUUID()}`;
    const now = Date.now();
    const seed = registryBinding(celldEnv());
    await seed
      .prepare("INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)")
      .bind(workspaceId, workspaceId, now)
      .run();
    await seed
      .prepare(
        "INSERT INTO agents (id, workspace_id, name, system_prompt, provider, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(agentId, workspaceId, "Default", "You are Nadi.", "mock", "mock", now)
      .run();

    const repo = new ThreadRepository(db);
    const threadId = `thr_tx_${crypto.randomUUID()}`;
    await expect(
      repo.create({
        id: threadId,
        workspaceId,
        agentId,
        title: "fallback thread",
        titleSet: true,
        runtime: "think",
        source: "manual" as const,
        createdAt: now,
        updatedAt: now,
      }),
    ).resolves.toBeDefined();

    const persisted = await db
      .select()
      .from(schema.threadIndex)
      .where(eq(schema.threadIndex.id, threadId))
      .get();
    expect(persisted?.title).toBe("fallback thread");
  });
});

describe("parity with the real D1 binding", () => {
  it("identical raw SQL sequences produce identical rows on both bindings", async () => {
    const real = poolEnv.REGISTRY_DB;
    const facade = registryBinding(celldEnv());
    for (const db of [real, facade]) {
      await db.exec("CREATE TABLE IF NOT EXISTS parity_probe (id INTEGER PRIMARY KEY, v TEXT)");
      await db.exec("DELETE FROM parity_probe");
      await db.batch([
        db.prepare("INSERT INTO parity_probe (id, v) VALUES (1, 'a')"),
        db.prepare("INSERT INTO parity_probe (id, v) VALUES (2, 'b')"),
      ]);
    }
    const realRows = await execAll(real, "SELECT id, v FROM parity_probe ORDER BY id");
    const facadeRows = await execAll(facade, "SELECT id, v FROM parity_probe ORDER BY id");
    expect(facadeRows).toEqual(realRows);
    expect(facadeRows).toEqual([
      { id: 1, v: "a" },
      { id: 2, v: "b" },
    ]);

    await real.prepare("UPDATE parity_probe SET v = ? WHERE id = ?").bind("A", 1).run();
    await facade.prepare("UPDATE parity_probe SET v = ? WHERE id = ?").bind("A", 1).run();
    expect(await execAll(facade, "SELECT v FROM parity_probe WHERE id = 1")).toEqual(
      await execAll(real, "SELECT v FROM parity_probe WHERE id = 1"),
    );
  });

  it("ThreadRepository and AutomatonRepository behave identically on both", async () => {
    const realDb = registryDb(poolEnv);
    const facadeDb = registryDb(celldEnv());
    const realSeed = poolEnv.REGISTRY_DB;
    const facadeSeed = registryBinding(celldEnv());

    const workspaceId = `ws_parity_${crypto.randomUUID()}`;
    const agentId = `agent_parity_${crypto.randomUUID()}`;
    const ownerUserId = `user_parity_${crypto.randomUUID()}`;
    const automatonId = `automaton_parity_${crypto.randomUUID()}`;
    const futureAutomatonId = `automaton_parity_future_${crypto.randomUUID()}`;
    const now = Date.now();
    for (const seed of [realSeed, facadeSeed]) {
      await seed
        .prepare("INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)")
        .bind(workspaceId, workspaceId, now)
        .run();
      await seed
        .prepare(
          "INSERT INTO users (id, email, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(ownerUserId, `${ownerUserId}@example.com`, "Parity", now, now)
        .run();
      await seed
        .prepare(
          "INSERT INTO agents (id, workspace_id, name, system_prompt, provider, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(agentId, workspaceId, "Default", "You are Nadi.", "mock", "mock", now)
        .run();
      await seed
        .prepare(
          "INSERT INTO automata (id, workspace_id, owner_user_id, agent_id, name, prompt, schedule_json, timezone, enabled, next_due_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          automatonId,
          workspaceId,
          ownerUserId,
          agentId,
          "parity",
          "prompt",
          "{}",
          "UTC",
          1,
          now - 1000,
          now,
          now,
        )
        .run();
      await seed
        .prepare(
          "INSERT INTO automata (id, workspace_id, owner_user_id, agent_id, name, prompt, schedule_json, timezone, enabled, next_due_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          futureAutomatonId,
          workspaceId,
          ownerUserId,
          agentId,
          "parity-future",
          "prompt",
          "{}",
          "UTC",
          1,
          now + 100_000,
          now,
          now,
        )
        .run();
    }

    const realThreads = new ThreadRepository(realDb);
    const facadeThreads = new ThreadRepository(facadeDb);
    const threadId = `thr_parity_${crypto.randomUUID()}`;
    const insert = {
      id: threadId,
      workspaceId,
      agentId,
      title: "parity thread",
      titleSet: true,
      runtime: "think" as const,
      source: "manual" as const,
      createdAt: now,
      updatedAt: now,
    };
    await realThreads.create(insert);
    await facadeThreads.create(insert);

    const realList = await realThreads.listForWorkspace(workspaceId);
    const facadeList = await facadeThreads.listForWorkspace(workspaceId);
    expect(facadeList).toEqual(realList);
    expect(facadeList.map((t) => t.id)).toContain(threadId);

    const realAutomata = new AutomatonRepository(realDb);
    const facadeAutomata = new AutomatonRepository(facadeDb);
    const realDue = await realAutomata.listDue(now, 10);
    const facadeDue = await facadeAutomata.listDue(now, 10);
    expect(facadeDue).toEqual(realDue);
    expect(facadeDue.length).toBeGreaterThanOrEqual(1);
    expect(facadeDue.every((a) => a.nextDueAt! < now + 1)).toBe(true);
  });
});

describe("sign-in over the facade-backed registry", () => {
  it("runs the OTP flow end-to-end with the registry in a Durable Object", async () => {
    const email = `facade-${crypto.randomUUID()}@example.com`;
    const facadeEnv = celldEnv({ WHITELISTED_EMAILS: "example.com" });
    const auth = buildAuth(facadeEnv);

    const send = await auth.handler(
      new Request("https://nadi.test/api/auth/email-otp/send-verification-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, type: "sign-in" }),
      }),
    );
    expect(send.status).toBe(200);

    // Read the OTP back through the facade: it must have been persisted to the
    // DO's storage, not held in memory.
    const db = registryDb(facadeEnv);
    const verifications = await db.select().from(schema.verifications).all();
    const verification = verifications.find((row) => row.identifier.includes(email));
    expect(verification).toBeDefined();
    const otp = verification?.value.split(":").at(0);
    expect(otp).toBeDefined();

    const signIn = await auth.handler(
      new Request("https://nadi.test/api/auth/sign-in/email-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, otp }),
      }),
    );
    expect(signIn.status).toBe(200);
    const cookie = signIn.headers
      .get("set-cookie")
      ?.match(/(?:^|,\s*)((?:__Secure-)?better-auth\.session_token=[^;,]+)/)?.[1];
    expect(cookie).toBeDefined();

    await expect(
      validateRequestSession(
        facadeEnv,
        new Request("https://nadi.test/protected", { headers: { cookie: cookie ?? "" } }),
      ),
    ).resolves.toMatchObject({ user: { email } });
  });
});
