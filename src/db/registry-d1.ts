import type {
  RegistryAllResult,
  RegistryDatabase,
  RegistryRawResult,
  RegistryRunResult,
} from "./registry-do";

/**
 * A D1-shaped facade over the celld RegistryDatabase Durable Object.
 *
 * Cloudflare keeps the real D1 binding; celld has no D1, so `registryBinding`
 * hands every consumer a `RegistryD1` instead. It implements the D1 surface
 * the app actually touches — `prepare`/`bind`/`all`/`first`/`run`/`raw`/
 * `batch`/`exec` — by translating each call into an RPC over the singleton
 * `RegistryDatabase`. `drizzle-orm/d1` consumes this object exactly like a D1
 * binding, so `registryDb(env)` needs no platform branch.
 */

/** The name of the singleton RegistryDatabase DO every facade talks to. */
export const REGISTRY_DO_ID = "registry";

const TRANSACTION_CONTROL_SQL: Record<string, string> = {
  begin: "BEGIN TRANSACTION",
  commit: "COMMIT",
  rollback: "ROLLBACK",
  savepoint: "SAVEPOINT",
  release: "RELEASE",
};

/**
 * D1 rejects transaction-control SQL; repositories rely on the exact shape of
 * that error (`withTransactionalWrite` in threads.ts / feedback.ts matches on
 * "please use the state.storage.transaction()" + "SQL BEGIN TRANSACTION") to
 * fall back to the durable-object storage transaction. The facade must produce
 * that same error locally — never a workerd RPC error — so the fallback
 * recognises it. Both the facade and the DO apply it, so direct RPC users get
 * D1 behavior too.
 */
export function assertNotTransactionControl(sql: string): void {
  const firstToken = sql.trim().split(/\s+/, 1)[0]?.toLowerCase();
  const label = firstToken ? TRANSACTION_CONTROL_SQL[firstToken] : undefined;
  if (label) {
    throw new Error(
      `D1_ERROR: please use the state.storage.transaction() API instead of the SQL ${label} statement.`,
    );
  }
}

/** Split SQL into statements on top-level semicolons, respecting string
 *  literals (`'…'`, `"…"`, `` `…` ``) and comments (`-- …` and `/* … *​/`).
 *  Chunks that contain nothing but whitespace/comments are dropped — workerd
 *  errors on a comment-only statement. */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (lineComment) {
      current += ch;
      if (ch === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      current += ch;
      if (ch === "*" && next === "/") {
        current += next;
        i++;
        blockComment = false;
      }
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote && sql[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === "-" && next === "-") {
      lineComment = true;
      current += ch;
      continue;
    }
    if (ch === "/" && next === "*") {
      blockComment = true;
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ";") {
      statements.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  statements.push(current);
  return statements.map((s) => s.trim()).filter((s) => s.length > 0 && !isBlankStatement(s));
}

function isBlankStatement(sql: string): boolean {
  return (
    sql
      .replace(/--[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .trim().length === 0
  );
}

export class RegistryD1 implements D1Database {
  private readonly stub: DurableObjectStub<RegistryDatabase>;

  constructor(namespace: DurableObjectNamespace<RegistryDatabase>) {
    this.stub = namespace.get(namespace.idFromName(REGISTRY_DO_ID));
  }

  prepare(query: string): D1PreparedStatement {
    return new RegistryD1Statement(this.stub, query);
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const items = statements.map((statement) => {
      if (!(statement instanceof RegistryD1Statement)) {
        throw new Error("RegistryD1.batch: every statement must come from this facade's prepare()");
      }
      return { sql: statement.sql, params: statement.params };
    });
    for (const item of items) assertNotTransactionControl(item.sql);
    return (await this.stub.execBatch(items)) as unknown as D1Result<T>[];
  }

  async exec(query: string): Promise<D1ExecResult> {
    const statements = splitSqlStatements(query);
    let duration = 0;
    for (const statement of statements) {
      assertNotTransactionControl(statement);
      const result = (await this.stub.exec(statement, [], "run")) as RegistryRunResult;
      duration += result.meta.duration;
    }
    return { count: statements.length, duration };
  }

  withSession(): D1DatabaseSession {
    // celld has a single registry node, so "sequential consistency" is
    // trivially the same object. Nothing in the app calls this; it exists to
    // keep the D1Database surface honest.
    const session: D1DatabaseSession = {
      prepare: (query: string) => this.prepare(query),
      batch: <T = unknown>(statements: D1PreparedStatement[]) => this.batch<T>(statements),
      getBookmark: () => null,
    };
    return session;
  }

  dump(): Promise<ArrayBuffer> {
    throw new Error(
      "RegistryD1: dump() is not supported — the registry lives in a Durable Object.",
    );
  }
}

class RegistryD1Statement implements D1PreparedStatement {
  private boundParams: unknown[] = [];

  constructor(
    private readonly stub: DurableObjectStub<RegistryDatabase>,
    readonly sql: string,
  ) {}

  get params(): unknown[] {
    return this.boundParams;
  }

  bind(...values: unknown[]): this {
    this.boundParams = values;
    return this;
  }

  async first<T = Record<string, unknown>>(): Promise<T | null>;
  async first<T = unknown>(colName: string): Promise<T | null>;
  async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
    const { results } = (await this.stub.exec(
      this.sql,
      this.boundParams,
      "all",
    )) as RegistryAllResult;
    const row = results[0];
    if (colName === undefined) return (row as T | undefined) ?? null;
    return (row?.[colName] as T | undefined) ?? null;
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    assertNotTransactionControl(this.sql);
    return (await this.stub.exec(this.sql, this.boundParams, "run")) as unknown as D1Result<T>;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return (await this.stub.exec(this.sql, this.boundParams, "all")) as unknown as D1Result<T>;
  }

  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
    const { columnNames, rows } = (await this.stub.exec(
      this.sql,
      this.boundParams,
      "raw",
    )) as RegistryRawResult;
    if (options?.columnNames) {
      return [columnNames, ...rows] as unknown as T[];
    }
    return rows as unknown as T[];
  }
}
