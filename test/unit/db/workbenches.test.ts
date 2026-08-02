import { beforeEach, describe, expect, it, vi } from "vitest";

const now = 1_800_000_000_000;

const workbenches = {
  __table: "workbenches",
  id: "id",
  workspaceId: "workspace_id",
  archivedAt: "archived_at",
  updatedAt: "updated_at",
  $inferInsert: {} as {
    id: string;
    workspaceId: string;
    name: string;
    description?: string;
    setupScript?: string;
    sandboxEnvVarsJson?: string;
    createdAt: number;
    updatedAt: number;
  },
};

const workbenchRepositories = {
  __table: "workbench_repositories",
  id: "id",
  workbenchId: "workbench_id",
  createdAt: "created_at",
};

vi.mock("drizzle-orm", () => ({
  eq: (column: string, value: unknown) => (row: Record<string, unknown>) => row[column] === value,
  and:
    (...conditions: Array<(row: Record<string, unknown>) => boolean>) =>
    (row: Record<string, unknown>) =>
      conditions.every((condition) => condition(row)),
  isNull: (column: string) => (row: Record<string, unknown>) => row[column] == null,
  isNotNull: (column: string) => (row: Record<string, unknown>) => row[column] != null,
  asc: (column: string) => ({ column, dir: "asc" }),
  desc: (column: string) => ({ column, dir: "desc" }),
}));

vi.mock("../../../src/db/schema", () => ({
  workbenches,
  workbenchRepositories,
}));

interface WorkbenchRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  setup_script: string;
  sandbox_env_vars_json: string;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
}

interface WorkbenchRepositoryRow {
  id: string;
  workbench_id: string;
  source: string;
  name: string;
  url: string;
  github_repo_id: number | null;
  source_installation_id: string | null;
  checkout_path_name: string;
  default_branch: string;
  root_directory: string;
  setup_command: string;
  package_manager: string;
  created_at: number;
}

type Row = WorkbenchRow | WorkbenchRepositoryRow;
type Condition = (row: Record<string, any>) => boolean;
type SortSpec = { column: string; dir: string };

class WorkbenchRepositoryTestDb {
  workbenches = new Map<string, WorkbenchRow>();
  workbenchRepositories = new Map<string, WorkbenchRepositoryRow>();

  select(projection?: Record<string, any>) {
    const self = this;
    return {
      from: (table: { __table: string }) => ({
        where: (condition: Condition) => ({
          get: async () => {
            const row = self.read(table, condition)[0];
            if (!row) return undefined;
            const denormalized = self.denormalizeRow(table, row);
            return projection ? self.applyProjection(denormalized, projection) : denormalized;
          },
          all: async () => {
            const rows = self.read(table, condition);
            return rows.map((row) => {
              const denormalized = self.denormalizeRow(table, row);
              return projection ? self.applyProjection(denormalized, projection) : denormalized;
            });
          },
          orderBy: (sortSpec: SortSpec) => ({
            all: async () => {
              const rows = self.read(table, condition);
              const sorted = self.sort(rows, sortSpec);
              return sorted.map((row) => {
                const denormalized = self.denormalizeRow(table, row);
                return projection ? self.applyProjection(denormalized, projection) : denormalized;
              });
            },
          }),
        }),
        orderBy: (sortSpec: SortSpec) => ({
          all: async () => {
            const rows = self.read(table, undefined);
            const sorted = self.sort(rows, sortSpec);
            return sorted.map((row) => {
              const denormalized = self.denormalizeRow(table, row);
              return projection ? self.applyProjection(denormalized, projection) : denormalized;
            });
          },
        }),
      }),
    };
  }

  private denormalizeRow(table: { __table: string }, row: Row): any {
    if (table.__table === "workbenches") {
      return denormalizeWorkbenchRow(row as WorkbenchRow);
    } else if (table.__table === "workbench_repositories") {
      return denormalizeWorkbenchRepositoryRow(row as WorkbenchRepositoryRow);
    }
    return row;
  }

  private applyProjection(row: any, projection: Record<string, any>): any {
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(projection)) {
      result[key] = row[value];
    }
    return result;
  }

  insert(table: { __table: string }) {
    const self = this;
    return {
      values: (row: Row | Row[]) => {
        const promise = new Promise<void>((resolve) => {
          const rows = Array.isArray(row) ? row : [row];
          for (const r of rows) {
            if (table.__table === "workbenches") {
              const wbRow = normalizeWorkbenchRow(r);
              self.workbenches.set(wbRow.id, wbRow);
            } else if (table.__table === "workbench_repositories") {
              const wbrRow = normalizeWorkbenchRepositoryRow(r);
              self.workbenchRepositories.set(wbrRow.id, wbrRow);
            }
          }
          resolve();
        });
        return promise;
      },
    };
  }

  update(table: { __table: string }) {
    const self = this;
    return {
      set: (patch: any) => ({
        where: (condition: Condition) => {
          const promise = new Promise<void>((resolve) => {
            if (table.__table === "workbenches") {
              for (const [id, row] of self.workbenches.entries()) {
                if (condition(row)) {
                  const normalizedPatch: any = {};
                  if (patch.archivedAt !== undefined)
                    normalizedPatch.archived_at = patch.archivedAt;
                  if (patch.updatedAt !== undefined) normalizedPatch.updated_at = patch.updatedAt;
                  if (patch.name !== undefined) normalizedPatch.name = patch.name;
                  if (patch.description !== undefined)
                    normalizedPatch.description = patch.description;
                  if (patch.setupScript !== undefined)
                    normalizedPatch.setup_script = patch.setupScript;
                  if (patch.sandboxEnvVarsJson !== undefined)
                    normalizedPatch.sandbox_env_vars_json = patch.sandboxEnvVarsJson;
                  self.workbenches.set(id, { ...row, ...normalizedPatch } as WorkbenchRow);
                }
              }
            }
            resolve();
          });
          return promise;
        },
      }),
    };
  }

  delete(table: { __table: string }) {
    const self = this;
    return {
      where: (condition: Condition) => {
        const promise = new Promise<void>((resolve) => {
          if (table.__table === "workbench_repositories") {
            for (const [key, row] of self.workbenchRepositories.entries()) {
              if (condition(row)) {
                self.workbenchRepositories.delete(key);
              }
            }
          }
          resolve();
        });
        return promise;
      },
    };
  }

  async batch(statements: Promise<any>[]) {
    for (const stmt of statements) {
      await stmt;
    }
  }

  private read(table: { __table: string }, condition?: Condition) {
    let rows: Row[] = [];
    if (table.__table === "workbenches") {
      rows = [...this.workbenches.values()] as Row[];
    } else if (table.__table === "workbench_repositories") {
      rows = [...this.workbenchRepositories.values()] as Row[];
    }
    return condition ? rows.filter((row) => condition(row)) : rows;
  }

  private sort(rows: Row[], sortSpec: SortSpec) {
    const { column, dir } = sortSpec;
    return rows.sort((a, b) => {
      const aVal = (a as unknown as Record<string, unknown>)[column];
      const bVal = (b as unknown as Record<string, unknown>)[column];
      if (aVal == null && bVal == null) return 0;
      if (aVal == null) return 1;
      if (bVal == null) return -1;
      const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      return dir === "asc" ? cmp : -cmp;
    });
  }
}

function newWorkbenchRow(workspaceId: string): typeof workbenches.$inferInsert {
  return {
    id: `wb_${Math.random().toString(36).substr(2, 9)}`,
    workspaceId,
    name: "Test Workbench",
    description: "",
    setupScript: "",
    sandboxEnvVarsJson: "{}",
    createdAt: now,
    updatedAt: now,
  };
}

function normalizeWorkbenchRow(row: any): WorkbenchRow {
  return {
    id: row.id,
    workspace_id: row.workspaceId || row.workspace_id,
    name: row.name,
    description: row.description,
    setup_script: row.setupScript || row.setup_script,
    sandbox_env_vars_json: row.sandboxEnvVarsJson || row.sandbox_env_vars_json,
    archived_at: row.archivedAt || row.archived_at,
    created_at: row.createdAt || row.created_at,
    updated_at: row.updatedAt || row.updated_at,
  };
}

function denormalizeWorkbenchRow(row: WorkbenchRow): any {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    description: row.description,
    setupScript: row.setup_script,
    sandboxEnvVarsJson: row.sandbox_env_vars_json,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeWorkbenchRepositoryRow(row: any): WorkbenchRepositoryRow {
  return {
    id: row.id,
    workbench_id: row.workbenchId ?? row.workbench_id,
    source: row.source,
    name: row.name,
    url: row.url,
    github_repo_id: row.githubRepoId ?? row.github_repo_id ?? null,
    source_installation_id: row.sourceInstallationId ?? row.source_installation_id ?? null,
    checkout_path_name: row.checkoutPathName ?? row.checkout_path_name,
    default_branch: row.defaultBranch ?? row.default_branch,
    root_directory: row.rootDirectory ?? row.root_directory,
    setup_command: row.setupCommand ?? row.setup_command,
    package_manager: row.packageManager ?? row.package_manager,
    created_at: row.createdAt ?? row.created_at,
  };
}

function denormalizeWorkbenchRepositoryRow(row: WorkbenchRepositoryRow): any {
  return {
    id: row.id,
    workbenchId: row.workbench_id,
    source: row.source,
    name: row.name,
    url: row.url,
    githubRepoId: row.github_repo_id,
    sourceInstallationId: row.source_installation_id,
    checkoutPathName: row.checkout_path_name,
    defaultBranch: row.default_branch,
    rootDirectory: row.root_directory,
    setupCommand: row.setup_command,
    packageManager: row.package_manager,
    createdAt: row.created_at,
  };
}

function entry(name: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    source: "url" as const,
    name,
    url: `https://example.com/${name}.git`,
    checkoutPathName: name,
    defaultBranch: "main",
    rootDirectory: "",
    setupCommand: "",
    packageManager: "",
    ...overrides,
  };
}

describe("WorkbenchRepository", () => {
  let db: WorkbenchRepositoryTestDb;
  let WorkbenchRepository: typeof import("../../../src/db/repositories/workbenches").WorkbenchRepository;

  beforeEach(async () => {
    vi.resetModules();
    ({ WorkbenchRepository } = await import("../../../src/db/repositories/workbenches"));
    db = new WorkbenchRepositoryTestDb();
  });

  it("creates and retrieves a workbench", async () => {
    const repo = new WorkbenchRepository(db as never);
    const input = newWorkbenchRow("workspace-1");
    const wb = await repo.create(input);

    expect(wb.id).toBe(input.id);
    expect(wb.name).toBe("Test Workbench");
    expect(wb.workspaceId).toBe("workspace-1");

    const retrieved = await repo.getById(wb.id);
    expect(retrieved).toEqual(wb);
  });

  it("lists active workbenches for a workspace", async () => {
    const repo = new WorkbenchRepository(db as never);
    const wb1 = await repo.create(newWorkbenchRow("workspace-1"));
    const wb2 = await repo.create(newWorkbenchRow("workspace-1"));

    const active = await repo.listForWorkspace("workspace-1", "active");
    expect(active).toHaveLength(2);
    expect(active.map((e) => e.id)).toContain(wb1.id);
    expect(active.map((e) => e.id)).toContain(wb2.id);
  });

  it("excludes archived workbenches from active list", async () => {
    const repo = new WorkbenchRepository(db as never);
    const wb1 = await repo.create(newWorkbenchRow("workspace-1"));
    const wb2 = await repo.create(newWorkbenchRow("workspace-1"));

    await repo.archive(wb2.id, now + 1);

    const active = await repo.listForWorkspace("workspace-1", "active");
    expect(active).toHaveLength(1);
    expect(active[0]?.id).toBe(wb1.id);
  });

  it("throws when asserting an archived workbench", async () => {
    const repo = new WorkbenchRepository(db as never);
    const wb = await repo.create(newWorkbenchRow("workspace-1"));

    await repo.archive(wb.id, now + 1);

    await expect(repo.assertActiveWorkbenchInWorkspace(wb.id, "workspace-1")).rejects.toThrow(
      "workbench_not_found",
    );
  });

  it("rejects a workbench from a foreign workspace", async () => {
    const repo = new WorkbenchRepository(db as never);
    const wb = await repo.create(newWorkbenchRow("workspace-1"));

    await expect(repo.assertActiveWorkbenchInWorkspace(wb.id, "workspace-2")).rejects.toThrow(
      "workbench_not_found",
    );
  });

  it("updates workbench fields", async () => {
    const repo = new WorkbenchRepository(db as never);
    const wb = await repo.create(newWorkbenchRow("workspace-1"));

    await repo.update(wb.id, {
      name: "Updated Name",
      description: "Updated description",
      updatedAt: now + 1,
    });

    const updated = await repo.getById(wb.id);
    expect(updated?.name).toBe("Updated Name");
    expect(updated?.description).toBe("Updated description");
    expect(updated?.updatedAt).toBe(now + 1);
  });

  it("replaces repository entries, inserting full config with generated ids", async () => {
    const repo = new WorkbenchRepository(db as never);
    const wb = await repo.create(newWorkbenchRow("workspace-1"));

    await repo.replaceRepositories(
      wb.id,
      "workspace-1",
      [
        entry("repo-a", { defaultBranch: "main", rootDirectory: "packages/a" }),
        entry("repo-b", { defaultBranch: "develop", rootDirectory: "apps/b" }),
      ],
      now,
    );

    const rows = await repo.listRepositories(wb.id);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.id).toBeTruthy();
      expect(row.workbenchId).toBe(wb.id);
    }
    const byName = new Map(rows.map((r) => [r.name, r]));
    expect(byName.get("repo-a")).toMatchObject({
      defaultBranch: "main",
      rootDirectory: "packages/a",
    });
    expect(byName.get("repo-b")).toMatchObject({
      defaultBranch: "develop",
      rootDirectory: "apps/b",
    });
  });

  it("replacing repositories again drops the previous set", async () => {
    const repo = new WorkbenchRepository(db as never);
    const wb = await repo.create(newWorkbenchRow("workspace-1"));

    await repo.replaceRepositories(wb.id, "workspace-1", [entry("repo-a")], now);
    await repo.replaceRepositories(wb.id, "workspace-1", [entry("repo-b")], now + 1);

    const rows = await repo.listRepositories(wb.id);
    expect(rows.map((r) => r.name)).toEqual(["repo-b"]);
  });

  it("rejects replacing repositories on a workbench outside the workspace", async () => {
    const repo = new WorkbenchRepository(db as never);
    const wb = await repo.create(newWorkbenchRow("workspace-1"));

    await expect(
      repo.replaceRepositories(wb.id, "workspace-other", [entry("repo-a")], now),
    ).rejects.toThrow("workbench_not_found");
  });
});
