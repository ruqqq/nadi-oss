import { beforeEach, describe, expect, it, vi } from "vitest";

const now = 1_800_000_000_000;

/**
 * Column refs are wrapped so the drizzle-orm mock below can tell columns
 * apart from literal values, including in join conditions comparing two
 * columns from different tables.
 */
function col(name: string) {
  return { __col: name };
}
type ColumnRef = ReturnType<typeof col>;

function isColumnRef(value: unknown): value is ColumnRef {
  return typeof value === "object" && value !== null && "__col" in value;
}

const workbenches = {
  __table: "workbenches",
  id: col("id"),
  workspaceId: col("workspaceId"),
  name: col("name"),
  setupScript: col("setupScript"),
  resourceProfile: col("resourceProfile"),
};

const workbenchRepositories = {
  __table: "workbench_repositories",
  id: col("id"),
  workbenchId: col("workbenchId"),
  name: col("name"),
  url: col("url"),
  defaultBranch: col("defaultBranch"),
  checkoutPathName: col("checkoutPathName"),
  rootDirectory: col("rootDirectory"),
  setupCommand: col("setupCommand"),
  packageManager: col("packageManager"),
};

const threadRepositorySnapshots = {
  __table: "thread_repository_snapshots",
  id: col("id"),
  threadId: col("threadId"),
  workspaceId: col("workspaceId"),
  projectId: col("projectId"),
  workbenchId: col("workbenchId"),
  name: col("name"),
  url: col("url"),
  defaultBranch: col("defaultBranch"),
  checkoutPathName: col("checkoutPathName"),
  rootDirectory: col("rootDirectory"),
  setupCommand: col("setupCommand"),
  packageManager: col("packageManager"),
  createdAt: col("createdAt"),
};

const threadWorkbenchSnapshots = {
  __table: "thread_workbench_snapshots",
  threadId: col("threadId"),
  workspaceId: col("workspaceId"),
  workbenchId: col("workbenchId"),
  name: col("name"),
  setupScript: col("setupScript"),
  resourceProfile: col("resourceProfile"),
  createdAt: col("createdAt"),
};

type Row = Record<string, unknown>;
type Condition = (row: Row) => boolean;

vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown): Condition => {
    if (isColumnRef(a) && isColumnRef(b)) {
      return (row: Row) => row[a.__col] === row[b.__col];
    }
    if (isColumnRef(a)) {
      return (row: Row) => row[a.__col] === b;
    }
    throw new Error("eq: left-hand side must be a column ref");
  },
  and:
    (...conditions: Condition[]): Condition =>
    (row: Row) =>
      conditions.every((condition) => condition(row)),
  isNull:
    (a: ColumnRef): Condition =>
    (row: Row) =>
      row[a.__col] == null,
  asc: (a: ColumnRef) => ({ column: a.__col, dir: "asc" as const }),
  inArray:
    (a: ColumnRef, values: unknown[]): Condition =>
    (row: Row) =>
      values.includes(row[a.__col]),
}));

vi.mock("../../../src/db/schema", () => ({
  workbenches,
  workbenchRepositories,
  threadRepositorySnapshots,
  threadWorkbenchSnapshots,
}));

class FakeDb {
  tables: Record<string, Row[]> = {
    workbenches: [],
    workbench_repositories: [],
    thread_repository_snapshots: [],
    thread_workbench_snapshots: [],
  };

  select(projection?: Record<string, ColumnRef>) {
    return new SelectBuilder(this, projection);
  }

  insert(table: { __table: string }) {
    return {
      values: (rowOrRows: Row | Row[]) => {
        const rows = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
        this.tables[table.__table]!.push(...rows.map((row) => ({ ...row })));
        return Promise.resolve();
      },
    };
  }

  delete(table: { __table: string }) {
    return {
      where: (condition: Condition) => {
        const arr = this.tables[table.__table]!;
        const remaining = arr.filter((row) => !condition(row));
        arr.length = 0;
        arr.push(...remaining);
        return Promise.resolve();
      },
    };
  }
}

class SelectBuilder {
  private rows: Row[] = [];

  constructor(
    private readonly db: FakeDb,
    private readonly projection?: Record<string, ColumnRef>,
  ) {}

  from(table: { __table: string }) {
    this.rows = [...this.db.tables[table.__table]!];
    return this;
  }

  where(condition: Condition) {
    this.rows = this.rows.filter(condition);
    return this;
  }

  orderBy(spec: { column: string; dir: "asc" | "desc" }) {
    this.rows = [...this.rows].sort((a, b) => {
      const av = a[spec.column];
      const bv = b[spec.column];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return spec.dir === "asc" ? cmp : -cmp;
    });
    return this;
  }

  all(): Promise<Row[]> {
    return Promise.resolve(this.rows.map((row) => this.project(row)));
  }

  get(): Promise<Row | undefined> {
    const row = this.rows[0];
    return Promise.resolve(row ? this.project(row) : undefined);
  }

  private project(row: Row): Row {
    if (!this.projection) return { ...row };
    const result: Row = {};
    for (const [key, ref] of Object.entries(this.projection)) {
      result[key] = row[ref.__col];
    }
    return result;
  }
}

describe("ThreadRepositorySnapshotRepository", () => {
  let db: FakeDb;
  let ThreadRepositorySnapshotRepository: typeof import("../../../src/db/repositories/thread-repository-snapshots").ThreadRepositorySnapshotRepository;

  beforeEach(async () => {
    vi.resetModules();
    ({ ThreadRepositorySnapshotRepository } =
      await import("../../../src/db/repositories/thread-repository-snapshots"));
    db = new FakeDb();

    db.tables.workbenches!.push({
      id: "wb-1",
      workspaceId: "workspace-1",
      name: "Workbench One",
      setupScript: "pnpm install",
    });

    // Two join rows with DISTINCT config, self-contained on workbench_repositories
    // (no join to workspace_repositories, which no longer exists).
    db.tables.workbench_repositories!.push(
      {
        id: "repo-a",
        workbenchId: "wb-1",
        name: "Repo A",
        url: "https://example.com/a.git",
        defaultBranch: "main",
        checkoutPathName: "a",
        rootDirectory: "packages/a",
        setupCommand: "pnpm install",
        packageManager: "pnpm",
      },
      {
        id: "repo-b",
        workbenchId: "wb-1",
        name: "Repo B",
        url: "https://example.com/b.git",
        defaultBranch: "develop",
        checkoutPathName: "b",
        rootDirectory: "apps/b",
        setupCommand: "yarn install",
        packageManager: "yarn",
      },
    );
  });

  it("buildFromWorkbench reads each repo's own config directly off workbench_repositories", async () => {
    const repo = new ThreadRepositorySnapshotRepository(db as never);

    const snapshots = await repo.buildFromWorkbench("thr_1", "workspace-1", "wb-1", now);

    expect(snapshots).toHaveLength(2);
    const byId = new Map(snapshots.map((s) => [s.name, s]));

    const a = byId.get("Repo A");
    expect(a).toMatchObject({
      workbenchId: "wb-1",
      url: "https://example.com/a.git",
      defaultBranch: "main",
      checkoutPathName: "a",
      rootDirectory: "packages/a",
      setupCommand: "pnpm install",
      packageManager: "pnpm",
    });

    const b = byId.get("Repo B");
    expect(b).toMatchObject({
      workbenchId: "wb-1",
      url: "https://example.com/b.git",
      defaultBranch: "develop",
      checkoutPathName: "b",
      rootDirectory: "apps/b",
      setupCommand: "yarn install",
      packageManager: "yarn",
    });

    for (const snapshot of snapshots) {
      expect(snapshot.projectId).toBeNull();
      expect((snapshot as Record<string, unknown>).workspaceRepositoryId).toBeUndefined();
    }
  });

  it("replaceFromWorkbench writes repository snapshots and the workbench snapshot", async () => {
    const repo = new ThreadRepositorySnapshotRepository(db as never);

    await repo.replaceFromWorkbench("thr_1", "workspace-1", "wb-1", now);

    const snapshots = await repo.listForThread("thr_1");
    expect(snapshots).toHaveLength(2);
    for (const snapshot of snapshots) {
      expect(snapshot.workbenchId).toBe("wb-1");
      expect(snapshot.projectId).toBeNull();
    }

    const workbenchSnapshot = await repo.listWorkbenchSnapshot("thr_1");
    expect(workbenchSnapshot).toMatchObject({
      threadId: "thr_1",
      workspaceId: "workspace-1",
      workbenchId: "wb-1",
      name: "Workbench One",
      setupScript: "pnpm install",
    });
  });

  it("replaceFromWorkbench with a null workbench clears both repo and workbench snapshots", async () => {
    const repo = new ThreadRepositorySnapshotRepository(db as never);
    await repo.replaceFromWorkbench("thr_1", "workspace-1", "wb-1", now);

    await repo.replaceFromWorkbench("thr_1", "workspace-1", null, now + 10);

    expect(await repo.listForThread("thr_1")).toHaveLength(0);
    expect(await repo.listWorkbenchSnapshot("thr_1")).toBeUndefined();
  });

  it("throws when the workbench does not belong to the workspace", async () => {
    const repo = new ThreadRepositorySnapshotRepository(db as never);

    await expect(
      repo.replaceFromWorkbench("thr_1", "workspace-other", "wb-1", now),
    ).rejects.toThrow("workbench_not_found");
  });

  it("freezes the workbench resource profile into the snapshot", async () => {
    db.tables.workbenches!.push({
      id: "wb-2",
      workspaceId: "workspace-1",
      name: "Workbench Two",
      setupScript: "",
      resourceProfile: "medium",
    });
    const repo = new ThreadRepositorySnapshotRepository(db as never);

    await repo.replaceFromWorkbench("thr_1", "workspace-1", "wb-2", now);

    const snapshot = await repo.listWorkbenchSnapshot("thr_1");
    expect(snapshot?.resourceProfile).toBe("medium");
  });
});
