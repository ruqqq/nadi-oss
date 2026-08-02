import { env } from "cloudflare:test";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { asc, eq } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WorkbenchRepository } from "../../src/db/repositories/workbenches";
import { ProjectRepository } from "../../src/db/repositories/projects";
import { ThreadRepositorySnapshotRepository } from "../../src/db/repositories/thread-repository-snapshots";
import * as schema from "../../src/db/schema";
import { ThreadRepository } from "../../src/db/repositories/threads";
import { serializeThread } from "../../src/http/thread-serialize";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";

type TestDb = DrizzleD1Database<typeof schema>;

function unsupportedD1BeginError() {
  return new DrizzleQueryError(
    "begin",
    [],
    new Error(
      "D1_ERROR: please use the state.storage.transaction() API instead of the SQL BEGIN TRANSACTION statement.",
    ),
  );
}

function forceUnsupportedTransactions(db: TestDb): TestDb {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === "transaction") {
        return async () => {
          throw unsupportedD1BeginError();
        };
      }

      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function runTransactionsInline(db: TestDb): TestDb {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === "transaction") {
        return async <T>(callback: (tx: TestDb) => Promise<T>) => callback(db);
      }

      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function failSnapshotDeletes(db: TestDb): TestDb {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === "delete") {
        return (table: unknown) => {
          if (table === schema.threadRepositorySnapshots) {
            return {
              where: async () => {
                throw new Error("snapshot_delete_failed");
              },
            };
          }

          return target.delete(table as never);
        };
      }

      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Fails only the FIRST `threadIndex` update (the trailing column write after
 * the snapshot phase has already committed) so the recovery reconcile's own
 * `threadIndex` update — the second call — can still succeed.
 */
function failFirstThreadIndexUpdate(db: TestDb): TestDb {
  let threadIndexUpdateCalls = 0;
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === "update") {
        return (table: unknown) => {
          if (table === schema.threadIndex) {
            threadIndexUpdateCalls += 1;
            if (threadIndexUpdateCalls === 1) {
              return {
                set: () => ({
                  where: async () => {
                    throw new Error("thread_index_update_failed");
                  },
                }),
              };
            }
          }

          return target.update(table as never);
        };
      }

      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Simulates D1's untrustworthy `meta.changes` (local D1 has returned `null`
 * where remote returned an integer — see src/compute/container-ledger.ts:71)
 * for the `threadIndex` UPDATE inside `commitWorkbenchSwitch`. The write
 * still executes for real against the underlying table; only the reported
 * change count is nulled out, forcing the read-back fallback to run.
 */
function nullOutThreadIndexChangeCount(db: TestDb): TestDb {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === "update") {
        return (table: unknown) => {
          const builder = target.update(table as never);
          if (table !== schema.threadIndex) return builder;

          return {
            set: (fields: unknown) => {
              const setBuilder = (
                builder as unknown as {
                  set: (f: unknown) => { where: (c: unknown) => Promise<{ meta?: unknown }> };
                }
              ).set(fields);
              return {
                where: async (condition: unknown) => {
                  const result = await setBuilder.where(condition);
                  return { ...result, meta: { ...(result.meta as object), changes: null } };
                },
              };
            },
          };
        };
      }

      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function seedWorkspace(
  registryDb: typeof env.REGISTRY_DB,
  input: { workspaceId: string; createdAt?: number },
) {
  await registryDb
    .prepare("INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)")
    .bind(input.workspaceId, input.workspaceId, input.createdAt ?? 1)
    .run();
}

async function seedAgent(
  registryDb: typeof env.REGISTRY_DB,
  input: { workspaceId: string; agentId: string; createdAt: number },
) {
  await registryDb
    .prepare(
      "INSERT INTO agents (id, workspace_id, name, system_prompt, provider, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      input.agentId,
      input.workspaceId,
      input.agentId,
      "You are Nadi.",
      "mock",
      "mock",
      input.createdAt,
    )
    .run();
}

async function seedProject(
  db: TestDb,
  input: { projectId: string; workspaceId: string; createdAt: number },
) {
  await new ProjectRepository(db).create({
    id: input.projectId,
    workspaceId: input.workspaceId,
    name: input.projectId,
    description: "",
    customInstructions: "",
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
}

async function seedEnvironment(
  db: TestDb,
  input: {
    workbenchId: string;
    workspaceId: string;
    name?: string;
    setupScript?: string;
    resourceProfile?: string;
    createdAt: number;
  },
) {
  await new WorkbenchRepository(db).create({
    id: input.workbenchId,
    workspaceId: input.workspaceId,
    name: input.name ?? input.workbenchId,
    description: "",
    setupScript: input.setupScript ?? "",
    resourceProfile: input.resourceProfile ?? "small",
    sandboxEnvVarsJson: "{}",
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
}

// Workbench repositories are self-contained (no workspace-level catalog): tests
// record intended repo config by id, then assign it directly to a workbench.
type SeededRepoConfig = {
  name: string;
  url: string;
  defaultBranch: string;
  checkoutPathName: string;
  rootDirectory: string;
  setupCommand: string;
  packageManager: string;
};
const seededRepoConfigs = new Map<string, SeededRepoConfig>();

async function seedWorkspaceRepository(
  _db: TestDb,
  input: {
    repositoryId: string;
    workspaceId: string;
    name?: string;
    url?: string;
    defaultBranch?: string;
    checkoutPathName?: string;
    rootDirectory?: string;
    setupCommand?: string;
    packageManager?: string;
    createdAt: number;
  },
) {
  seededRepoConfigs.set(input.repositoryId, {
    name: input.name ?? input.repositoryId,
    url: input.url ?? `https://github.com/acme/${input.repositoryId}.git`,
    defaultBranch: input.defaultBranch ?? "main",
    checkoutPathName: input.checkoutPathName ?? input.repositoryId,
    rootDirectory: input.rootDirectory ?? "",
    setupCommand: input.setupCommand ?? "",
    packageManager: input.packageManager ?? "",
  });
}

async function assignRepositoriesToEnvironment(
  db: TestDb,
  input: {
    workbenchId: string;
    workspaceId: string;
    repositoryIds: string[];
    createdAt: number;
  },
) {
  // Insert workbench_repositories rows directly with id = repositoryId so the
  // resulting snapshot ids stay deterministic (`${threadId}:${repositoryId}`).
  await new WorkbenchRepository(db).assertActiveWorkbenchInWorkspace(
    input.workbenchId,
    input.workspaceId,
  );
  for (const repositoryId of input.repositoryIds) {
    const config = seededRepoConfigs.get(repositoryId);
    if (!config) throw new Error(`unknown seeded repo config: ${repositoryId}`);
    await db.insert(schema.workbenchRepositories).values({
      id: repositoryId,
      workbenchId: input.workbenchId,
      source: "url",
      name: config.name,
      url: config.url,
      defaultBranch: config.defaultBranch,
      checkoutPathName: config.checkoutPathName,
      rootDirectory: config.rootDirectory,
      setupCommand: config.setupCommand,
      packageManager: config.packageManager,
      createdAt: input.createdAt,
    });
  }
}

describe("ThreadRepository", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  beforeEach(async () => {
    await drizzle(env.REGISTRY_DB, { schema }).delete(schema.threadRepositorySnapshots);
    await drizzle(env.REGISTRY_DB, { schema }).delete(schema.threadWorkbenchSnapshots);
    await drizzle(env.REGISTRY_DB, { schema }).delete(schema.threadIndex);
    await drizzle(env.REGISTRY_DB, { schema }).delete(schema.workbenchRepositories);
    await drizzle(env.REGISTRY_DB, { schema }).delete(schema.workbenches);
    await drizzle(env.REGISTRY_DB, { schema }).delete(schema.projects);
    await drizzle(env.REGISTRY_DB, { schema }).delete(schema.agents);
    await drizzle(env.REGISTRY_DB, { schema }).delete(schema.workspaces);
  });
  afterEach(async () => {
    await drizzle(env.REGISTRY_DB, { schema }).delete(schema.threadRepositorySnapshots);
    await drizzle(env.REGISTRY_DB, { schema }).delete(schema.threadWorkbenchSnapshots);
    await drizzle(env.REGISTRY_DB, { schema }).delete(schema.threadIndex);
    await drizzle(env.REGISTRY_DB, { schema }).delete(schema.workbenchRepositories);
    await drizzle(env.REGISTRY_DB, { schema }).delete(schema.workbenches);
    await drizzle(env.REGISTRY_DB, { schema }).delete(schema.projects);
    await drizzle(env.REGISTRY_DB, { schema }).delete(schema.agents);
    await drizzle(env.REGISTRY_DB, { schema }).delete(schema.workspaces);
  });

  it("persists title, titleSet and updatedAt", async () => {
    await seedRegistryThread(env.REGISTRY_DB, { threadId: "thr_up", title: "New thread" });
    const db = drizzle(env.REGISTRY_DB, { schema });

    await new ThreadRepository(db).update("thr_up", {
      title: "Renamed",
      titleSet: true,
      updatedAt: 1_800_000_000_123,
    });

    const row = await db
      .select()
      .from(schema.threadIndex)
      .where(eq(schema.threadIndex.id, "thr_up"))
      .get();
    expect(row).toMatchObject({ title: "Renamed", titleSet: true, updatedAt: 1_800_000_000_123 });
  });

  it("replaceFromWorkbench copies assigned repository metadata and the setup script into snapshots, and keeps repo snapshots immutable", async () => {
    const createdAt = 1_800_000_000_111;
    await seedWorkspace(env.REGISTRY_DB, { workspaceId: "workspace-a", createdAt });
    const db = drizzle(env.REGISTRY_DB, { schema });
    await seedEnvironment(db, {
      workbenchId: "env-a",
      workspaceId: "workspace-a",
      name: "Env A",
      setupScript: "pnpm install",
      createdAt,
    });
    await seedWorkspaceRepository(db, {
      repositoryId: "repo-a",
      workspaceId: "workspace-a",
      name: "Repo A",
      url: "https://github.com/acme/repo-a.git",
      defaultBranch: "main",
      checkoutPathName: "repo-a",
      rootDirectory: "packages/app",
      setupCommand: "pnpm install",
      packageManager: "pnpm",
      createdAt,
    });
    await assignRepositoriesToEnvironment(db, {
      workbenchId: "env-a",
      workspaceId: "workspace-a",
      repositoryIds: ["repo-a"],
      createdAt,
    });
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-a",
      threadId: "thr_snapshot",
      createdAt,
      updatedAt: createdAt,
    });

    const snapshots = new ThreadRepositorySnapshotRepository(db);
    await snapshots.replaceFromWorkbench("thr_snapshot", "workspace-a", "env-a", createdAt);

    await expect(snapshots.listForThread("thr_snapshot")).resolves.toEqual([
      expect.objectContaining({
        id: "thr_snapshot:repo-a",
        threadId: "thr_snapshot",
        workspaceId: "workspace-a",
        projectId: null,
        workbenchId: "env-a",
        name: "Repo A",
        url: "https://github.com/acme/repo-a.git",
        defaultBranch: "main",
        checkoutPathName: "repo-a",
        rootDirectory: "packages/app",
        setupCommand: "pnpm install",
        packageManager: "pnpm",
        createdAt,
      }),
    ]);
    await expect(snapshots.listWorkbenchSnapshot("thr_snapshot")).resolves.toEqual(
      expect.objectContaining({
        threadId: "thr_snapshot",
        workspaceId: "workspace-a",
        workbenchId: "env-a",
        name: "Env A",
        setupScript: "pnpm install",
      }),
    );

    // Mutating the workbench's live repository must NOT change an existing snapshot.
    await db
      .update(schema.workbenchRepositories)
      .set({
        name: "Repo A Updated",
        url: "git@github.com:acme/repo-a.git",
        defaultBranch: "develop",
        checkoutPathName: "repo-a-updated",
        rootDirectory: "apps/web",
        setupCommand: "pnpm install --frozen-lockfile",
        packageManager: "npm",
      })
      .where(eq(schema.workbenchRepositories.id, "repo-a"));

    await expect(snapshots.listForThread("thr_snapshot")).resolves.toEqual([
      expect.objectContaining({
        id: "thr_snapshot:repo-a",
        name: "Repo A",
        url: "https://github.com/acme/repo-a.git",
        defaultBranch: "main",
        checkoutPathName: "repo-a",
        rootDirectory: "packages/app",
        setupCommand: "pnpm install",
        packageManager: "pnpm",
        createdAt,
      }),
    ]);
  });

  it("keeps a thread's frozen resource profile immutable when the workbench is later resized", async () => {
    const createdAt = 1_800_000_000_115;
    await seedWorkspace(env.REGISTRY_DB, { workspaceId: "workspace-a", createdAt });
    const db = drizzle(env.REGISTRY_DB, { schema });
    await seedEnvironment(db, {
      workbenchId: "env-resize",
      workspaceId: "workspace-a",
      resourceProfile: "small",
      createdAt,
    });
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-a",
      threadId: "thr_resize",
      createdAt,
      updatedAt: createdAt,
    });

    const snapshots = new ThreadRepositorySnapshotRepository(db);
    await snapshots.replaceFromWorkbench("thr_resize", "workspace-a", "env-resize", createdAt);

    await expect(snapshots.listWorkbenchSnapshot("thr_resize")).resolves.toEqual(
      expect.objectContaining({ resourceProfile: "small" }),
    );

    // A real SQL UPDATE on the live workbench row must not re-size the
    // already-frozen snapshot.
    await db
      .update(schema.workbenches)
      .set({ resourceProfile: "medium" })
      .where(eq(schema.workbenches.id, "env-resize"));

    const workbenchRow = await db
      .select()
      .from(schema.workbenches)
      .where(eq(schema.workbenches.id, "env-resize"))
      .get();
    expect(workbenchRow?.resourceProfile).toBe("medium");

    const snapshotRow = await db
      .select()
      .from(schema.threadWorkbenchSnapshots)
      .where(eq(schema.threadWorkbenchSnapshots.threadId, "thr_resize"))
      .get();
    expect(snapshotRow?.resourceProfile).toBe("small");
  });

  it("replaceFromWorkbench with a null environment clears both repo and environment snapshots", async () => {
    const createdAt = 1_800_000_000_117;
    await seedWorkspace(env.REGISTRY_DB, { workspaceId: "workspace-a", createdAt });
    const db = drizzle(env.REGISTRY_DB, { schema });
    await seedEnvironment(db, {
      workbenchId: "env-clear",
      workspaceId: "workspace-a",
      createdAt,
    });
    await seedWorkspaceRepository(db, {
      repositoryId: "repo-a",
      workspaceId: "workspace-a",
      createdAt,
    });
    await assignRepositoriesToEnvironment(db, {
      workbenchId: "env-clear",
      workspaceId: "workspace-a",
      repositoryIds: ["repo-a"],
      createdAt,
    });
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-a",
      threadId: "thr_env_clear",
      createdAt,
      updatedAt: createdAt,
    });

    const snapshots = new ThreadRepositorySnapshotRepository(db);
    await snapshots.replaceFromWorkbench("thr_env_clear", "workspace-a", "env-clear", createdAt);
    await snapshots.replaceFromWorkbench("thr_env_clear", "workspace-a", null, createdAt + 1);

    await expect(snapshots.listForThread("thr_env_clear")).resolves.toEqual([]);
    await expect(snapshots.listWorkbenchSnapshot("thr_env_clear")).resolves.toBeUndefined();
  });

  it("createWithWorkbench with null leaves the thread with no snapshots", async () => {
    const createdAt = 1_800_000_000_200;
    await seedWorkspace(env.REGISTRY_DB, { workspaceId: "workspace-a", createdAt });
    await seedAgent(env.REGISTRY_DB, {
      workspaceId: "workspace-a",
      agentId: "agent-workspace-a",
      createdAt,
    });
    const db = drizzle(env.REGISTRY_DB, { schema });
    const repo = new ThreadRepository(db);

    const created = await repo.createWithWorkbench(
      {
        id: "thr_unassigned",
        workspaceId: "workspace-a",
        agentId: "agent-workspace-a",
        projectId: null,
        title: "Unassigned",
        titleSet: false,
        runtime: "legacy",
        source: "manual",
        automatonId: null,
        automatonRunId: null,
        lastEventId: null,
        lastMessagePreview: "",
        archivedAt: null,
        createdAt,
        updatedAt: createdAt,
      },
      null,
    );

    expect(created.workbenchId).toBeNull();
    await expect(repo.getById("thr_unassigned")).resolves.toEqual(
      expect.objectContaining({ id: "thr_unassigned", workbenchId: null }),
    );
    await expect(
      new ThreadRepositorySnapshotRepository(db).listForThread("thr_unassigned"),
    ).resolves.toEqual([]);
  });

  it("createWithWorkbench with an environment persists it and snapshots its repositories", async () => {
    const createdAt = 1_800_000_000_300;
    await seedWorkspace(env.REGISTRY_DB, { workspaceId: "workspace-a", createdAt });
    await seedAgent(env.REGISTRY_DB, {
      workspaceId: "workspace-a",
      agentId: "agent-workspace-a",
      createdAt,
    });
    const db = drizzle(env.REGISTRY_DB, { schema });
    await seedEnvironment(db, { workbenchId: "env-a", workspaceId: "workspace-a", createdAt });
    await seedWorkspaceRepository(db, {
      repositoryId: "repo-a",
      workspaceId: "workspace-a",
      createdAt,
    });
    await assignRepositoriesToEnvironment(db, {
      workbenchId: "env-a",
      workspaceId: "workspace-a",
      repositoryIds: ["repo-a"],
      createdAt,
    });

    await new ThreadRepository(runTransactionsInline(db)).createWithWorkbench(
      {
        id: "thr_env_a",
        workspaceId: "workspace-a",
        agentId: "agent-workspace-a",
        projectId: null,
        title: "Env A",
        titleSet: false,
        runtime: "legacy",
        source: "manual",
        automatonId: null,
        automatonRunId: null,
        lastEventId: null,
        lastMessagePreview: "",
        archivedAt: null,
        createdAt,
        updatedAt: createdAt,
      },
      "env-a",
    );

    await expect(new ThreadRepository(db).getById("thr_env_a")).resolves.toEqual(
      expect.objectContaining({ workbenchId: "env-a" }),
    );
    await expect(
      new ThreadRepositorySnapshotRepository(db).listForThread("thr_env_a"),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "thr_env_a:repo-a",
        workbenchId: "env-a",
      }),
    ]);
  });

  it("getSummaryRowById enriches the thread with projectName and snapshot count", async () => {
    const createdAt = 1_800_000_000_900;
    await seedWorkspace(env.REGISTRY_DB, { workspaceId: "workspace-a", createdAt });
    await seedAgent(env.REGISTRY_DB, {
      workspaceId: "workspace-a",
      agentId: "agent-workspace-a",
      createdAt,
    });
    const db = drizzle(env.REGISTRY_DB, { schema });
    await seedProject(db, { projectId: "project-a", workspaceId: "workspace-a", createdAt });
    await seedEnvironment(db, { workbenchId: "env-a", workspaceId: "workspace-a", createdAt });
    await seedWorkspaceRepository(db, {
      repositoryId: "repo-a",
      workspaceId: "workspace-a",
      createdAt,
    });
    await assignRepositoriesToEnvironment(db, {
      workbenchId: "env-a",
      workspaceId: "workspace-a",
      repositoryIds: ["repo-a"],
      createdAt,
    });
    await new ThreadRepository(runTransactionsInline(db)).createWithWorkbench(
      {
        id: "thr_summary",
        workspaceId: "workspace-a",
        agentId: "agent-workspace-a",
        projectId: "project-a",
        title: "Summary",
        titleSet: false,
        runtime: "legacy",
        source: "manual",
        automatonId: null,
        automatonRunId: null,
        lastEventId: null,
        lastMessagePreview: "",
        archivedAt: null,
        createdAt,
        updatedAt: createdAt,
      },
      "env-a",
    );

    // Regression: live-update broadcasts serialize this row, so it must carry
    // the project chip data. A bare threadIndex row would report null/0 here and
    // the client's whole-object merge would wipe the sidebar chip until refetch.
    await expect(new ThreadRepository(db).getSummaryRowById("thr_summary")).resolves.toEqual(
      expect.objectContaining({
        id: "thr_summary",
        projectId: "project-a",
        projectName: "project-a",
        repositorySnapshotCount: 1,
      }),
    );
  });

  it("getSummaryRowById reports null projectName and zero count for an unassigned thread", async () => {
    const createdAt = 1_800_000_000_950;
    await seedWorkspace(env.REGISTRY_DB, { workspaceId: "workspace-a", createdAt });
    const db = drizzle(env.REGISTRY_DB, { schema });
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-a",
      threadId: "thr_unassigned_summary",
      projectId: null,
      createdAt,
      updatedAt: createdAt,
    });

    await expect(
      new ThreadRepository(db).getSummaryRowById("thr_unassigned_summary"),
    ).resolves.toEqual(
      expect.objectContaining({
        id: "thr_unassigned_summary",
        projectId: null,
        projectName: null,
        repositorySnapshotCount: 0,
      }),
    );
  });

  it("getSummaryRowById reports the FROZEN snapshot resourceProfile during a pending switch, not the live workbench's, and leaves repositorySnapshotCount unaffected by the join", async () => {
    const createdAt = 1_800_000_000_960;
    await seedWorkspace(env.REGISTRY_DB, { workspaceId: "workspace-a", createdAt });
    await seedAgent(env.REGISTRY_DB, {
      workspaceId: "workspace-a",
      agentId: "agent-workspace-a",
      createdAt,
    });
    const db = drizzle(env.REGISTRY_DB, { schema });

    // Old workbench: "small", holds the frozen snapshot the thread must keep
    // reporting while the switch is pending.
    await seedEnvironment(db, {
      workbenchId: "env-old",
      workspaceId: "workspace-a",
      resourceProfile: "small",
      createdAt,
    });
    // New workbench: "medium" and already the LIVE `threadIndex.workbenchId`
    // once the switch begins. Reading this instead of the snapshot is exactly
    // the bug this test exists to catch.
    await seedEnvironment(db, {
      workbenchId: "env-new",
      workspaceId: "workspace-a",
      resourceProfile: "medium",
      createdAt,
    });
    await seedWorkspaceRepository(db, {
      repositoryId: "repo-a",
      workspaceId: "workspace-a",
      createdAt,
    });
    await seedWorkspaceRepository(db, {
      repositoryId: "repo-b",
      workspaceId: "workspace-a",
      createdAt,
    });
    await assignRepositoriesToEnvironment(db, {
      workbenchId: "env-old",
      workspaceId: "workspace-a",
      repositoryIds: ["repo-a", "repo-b"],
      createdAt,
    });

    await new ThreadRepository(runTransactionsInline(db)).createWithWorkbench(
      {
        id: "thr_mid_switch",
        workspaceId: "workspace-a",
        agentId: "agent-workspace-a",
        title: "Mid switch",
        titleSet: false,
        runtime: "think",
        source: "manual",
        automatonId: null,
        automatonRunId: null,
        lastEventId: null,
        lastMessagePreview: "",
        archivedAt: null,
        createdAt,
        updatedAt: createdAt,
      },
      "env-old",
    );

    // repositorySnapshotCount is 2 here — the multi-snapshot case that would
    // expose a row-multiplying join.
    const beforeSwitch = await new ThreadRepository(db).getSummaryRowById("thr_mid_switch");
    expect(beforeSwitch?.repositorySnapshotCount).toBe(2);

    // Open the switch window: `threadIndex.workbenchId` becomes the NEW
    // workbench (intent) while `thread_workbench_snapshots` stays on the OLD
    // one (reality) until commit.
    await new ThreadRepository(db).beginWorkbenchSwitch("thr_mid_switch", "env-new", createdAt + 1);

    const row = await new ThreadRepository(db).getSummaryRowById("thr_mid_switch");
    expect(row).toBeTruthy();
    expect(row?.workbenchId).toBe("env-new");
    expect(row?.workbenchSwitchPendingAt).not.toBeNull();
    // The join must read the frozen snapshot's profile ("small"), never the
    // live workbench's ("medium") — and the pre-existing repository-snapshot
    // join must still report the true count of 2, not 4.
    expect(row?.snapshotResourceProfile).toBe("small");
    expect(row?.repositorySnapshotCount).toBe(2);

    const summary = serializeThread(row!);
    expect(summary.resourceProfile).toBe("small");
    expect(summary.workbenchSwitchPending).toBe(true);
    expect(summary.repositorySnapshotCount).toBe(2);
  });

  it("createWithWorkbench with an environment fails closed when transactions are unsupported", async () => {
    const createdAt = 1_800_000_000_350;
    await seedWorkspace(env.REGISTRY_DB, { workspaceId: "workspace-a", createdAt });
    await seedAgent(env.REGISTRY_DB, {
      workspaceId: "workspace-a",
      agentId: "agent-workspace-a",
      createdAt,
    });
    const db = drizzle(env.REGISTRY_DB, { schema });
    await seedEnvironment(db, { workbenchId: "env-a", workspaceId: "workspace-a", createdAt });
    await seedWorkspaceRepository(db, {
      repositoryId: "repo-a",
      workspaceId: "workspace-a",
      createdAt,
    });
    await assignRepositoriesToEnvironment(db, {
      workbenchId: "env-a",
      workspaceId: "workspace-a",
      repositoryIds: ["repo-a"],
      createdAt,
    });

    await expect(
      new ThreadRepository(forceUnsupportedTransactions(db)).createWithWorkbench(
        {
          id: "thr_env_unsupported",
          workspaceId: "workspace-a",
          agentId: "agent-workspace-a",
          projectId: null,
          title: "Unsupported Transaction",
          titleSet: false,
          runtime: "legacy",
          source: "manual",
          automatonId: null,
          automatonRunId: null,
          lastEventId: null,
          lastMessagePreview: "",
          archivedAt: null,
          createdAt,
          updatedAt: createdAt,
        },
        "env-a",
      ),
    ).rejects.toThrow("Failed query: begin");

    await expect(new ThreadRepository(db).getById("thr_env_unsupported")).resolves.toBeUndefined();
    await expect(
      new ThreadRepositorySnapshotRepository(db).listForThread("thr_env_unsupported"),
    ).resolves.toEqual([]);
  });

  it("updateProject only changes the project label, leaving snapshots untouched", async () => {
    const createdAt = 1_800_000_000_390;
    await seedWorkspace(env.REGISTRY_DB, { workspaceId: "workspace-a", createdAt });
    await seedAgent(env.REGISTRY_DB, {
      workspaceId: "workspace-a",
      agentId: "agent-workspace-a",
      createdAt,
    });
    const db = drizzle(env.REGISTRY_DB, { schema });
    await seedProject(db, { projectId: "project-a", workspaceId: "workspace-a", createdAt });
    await seedProject(db, { projectId: "project-b", workspaceId: "workspace-a", createdAt });
    await seedEnvironment(db, { workbenchId: "env-a", workspaceId: "workspace-a", createdAt });
    await seedWorkspaceRepository(db, {
      repositoryId: "repo-a",
      workspaceId: "workspace-a",
      createdAt,
    });
    await assignRepositoriesToEnvironment(db, {
      workbenchId: "env-a",
      workspaceId: "workspace-a",
      repositoryIds: ["repo-a"],
      createdAt,
    });
    await new ThreadRepository(runTransactionsInline(db)).createWithWorkbench(
      {
        id: "thr_relabel",
        workspaceId: "workspace-a",
        agentId: "agent-workspace-a",
        projectId: "project-a",
        title: "Relabel Me",
        titleSet: false,
        runtime: "legacy",
        source: "manual",
        automatonId: null,
        automatonRunId: null,
        lastEventId: null,
        lastMessagePreview: "",
        archivedAt: null,
        createdAt,
        updatedAt: createdAt,
      },
      "env-a",
    );

    await new ThreadRepository(db).updateProject("thr_relabel", "project-b", createdAt + 50);

    await expect(new ThreadRepository(db).getById("thr_relabel")).resolves.toEqual(
      expect.objectContaining({
        projectId: "project-b",
        workbenchId: "env-a",
        updatedAt: createdAt + 50,
      }),
    );
    await expect(
      new ThreadRepositorySnapshotRepository(db).listForThread("thr_relabel"),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "thr_relabel:repo-a",
        workbenchId: "env-a",
      }),
    ]);
  });

  it("updateWorkbench replaces snapshots when moving the thread to another environment", async () => {
    const createdAt = 1_800_000_000_400;
    await seedWorkspace(env.REGISTRY_DB, { workspaceId: "workspace-a", createdAt });
    await seedAgent(env.REGISTRY_DB, {
      workspaceId: "workspace-a",
      agentId: "agent-workspace-a",
      createdAt,
    });
    const db = drizzle(env.REGISTRY_DB, { schema });
    await seedEnvironment(db, { workbenchId: "env-a", workspaceId: "workspace-a", createdAt });
    await seedEnvironment(db, { workbenchId: "env-b", workspaceId: "workspace-a", createdAt });
    await seedWorkspaceRepository(db, {
      repositoryId: "repo-a",
      workspaceId: "workspace-a",
      createdAt,
    });
    await seedWorkspaceRepository(db, {
      repositoryId: "repo-b",
      workspaceId: "workspace-a",
      createdAt,
    });
    await assignRepositoriesToEnvironment(db, {
      workbenchId: "env-a",
      workspaceId: "workspace-a",
      repositoryIds: ["repo-a"],
      createdAt,
    });
    await assignRepositoriesToEnvironment(db, {
      workbenchId: "env-b",
      workspaceId: "workspace-a",
      repositoryIds: ["repo-b"],
      createdAt,
    });
    await new ThreadRepository(runTransactionsInline(db)).createWithWorkbench(
      {
        id: "thr_move",
        workspaceId: "workspace-a",
        agentId: "agent-workspace-a",
        projectId: null,
        title: "Move Me",
        titleSet: false,
        runtime: "legacy",
        source: "manual",
        automatonId: null,
        automatonRunId: null,
        lastEventId: null,
        lastMessagePreview: "",
        archivedAt: null,
        createdAt,
        updatedAt: createdAt,
      },
      "env-a",
    );

    await new ThreadRepository(db).updateWorkbench("thr_move", "env-b", createdAt + 50);

    await expect(new ThreadRepository(db).getById("thr_move")).resolves.toEqual(
      expect.objectContaining({ workbenchId: "env-b", updatedAt: createdAt + 50 }),
    );
    await expect(
      new ThreadRepositorySnapshotRepository(db).listForThread("thr_move"),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "thr_move:repo-b",
        workbenchId: "env-b",
      }),
    ]);
  });

  it("updateWorkbench clears snapshots when the thread becomes unassigned", async () => {
    const createdAt = 1_800_000_000_500;
    await seedWorkspace(env.REGISTRY_DB, { workspaceId: "workspace-a", createdAt });
    await seedAgent(env.REGISTRY_DB, {
      workspaceId: "workspace-a",
      agentId: "agent-workspace-a",
      createdAt,
    });
    const db = drizzle(env.REGISTRY_DB, { schema });
    await seedEnvironment(db, { workbenchId: "env-a", workspaceId: "workspace-a", createdAt });
    await seedWorkspaceRepository(db, {
      repositoryId: "repo-a",
      workspaceId: "workspace-a",
      createdAt,
    });
    await assignRepositoriesToEnvironment(db, {
      workbenchId: "env-a",
      workspaceId: "workspace-a",
      repositoryIds: ["repo-a"],
      createdAt,
    });
    await new ThreadRepository(runTransactionsInline(db)).createWithWorkbench(
      {
        id: "thr_clear",
        workspaceId: "workspace-a",
        agentId: "agent-workspace-a",
        projectId: null,
        title: "Clear Me",
        titleSet: false,
        runtime: "legacy",
        source: "manual",
        automatonId: null,
        automatonRunId: null,
        lastEventId: null,
        lastMessagePreview: "",
        archivedAt: null,
        createdAt,
        updatedAt: createdAt,
      },
      "env-a",
    );

    await new ThreadRepository(db).updateWorkbench("thr_clear", null, createdAt + 60);

    await expect(new ThreadRepository(db).getById("thr_clear")).resolves.toEqual(
      expect.objectContaining({ workbenchId: null, updatedAt: createdAt + 60 }),
    );
    await expect(
      new ThreadRepositorySnapshotRepository(db).listForThread("thr_clear"),
    ).resolves.toEqual([]);
    await expect(
      new ThreadRepositorySnapshotRepository(db).listWorkbenchSnapshot("thr_clear"),
    ).resolves.toBeUndefined();
  });

  it("fallback updateWorkbench rejects an invalid environment without changing assignment or snapshots", async () => {
    const createdAt = 1_800_000_000_550;
    await seedWorkspace(env.REGISTRY_DB, { workspaceId: "workspace-a", createdAt });
    await seedAgent(env.REGISTRY_DB, {
      workspaceId: "workspace-a",
      agentId: "agent-workspace-a",
      createdAt,
    });
    const db = drizzle(env.REGISTRY_DB, { schema });
    await seedEnvironment(db, { workbenchId: "env-a", workspaceId: "workspace-a", createdAt });
    await seedWorkspaceRepository(db, {
      repositoryId: "repo-a",
      workspaceId: "workspace-a",
      createdAt,
    });
    await assignRepositoriesToEnvironment(db, {
      workbenchId: "env-a",
      workspaceId: "workspace-a",
      repositoryIds: ["repo-a"],
      createdAt,
    });
    await new ThreadRepository(runTransactionsInline(db)).createWithWorkbench(
      {
        id: "thr_invalid_move",
        workspaceId: "workspace-a",
        agentId: "agent-workspace-a",
        projectId: null,
        title: "Invalid Move",
        titleSet: false,
        runtime: "legacy",
        source: "manual",
        automatonId: null,
        automatonRunId: null,
        lastEventId: null,
        lastMessagePreview: "",
        archivedAt: null,
        createdAt,
        updatedAt: createdAt,
      },
      "env-a",
    );

    await expect(
      new ThreadRepository(forceUnsupportedTransactions(db)).updateWorkbench(
        "thr_invalid_move",
        "env-missing",
        createdAt + 70,
      ),
    ).rejects.toThrow();

    await expect(new ThreadRepository(db).getById("thr_invalid_move")).resolves.toEqual(
      expect.objectContaining({ workbenchId: "env-a", updatedAt: createdAt }),
    );
    await expect(
      new ThreadRepositorySnapshotRepository(db).listForThread("thr_invalid_move"),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "thr_invalid_move:repo-a",
        workbenchId: "env-a",
      }),
    ]);
  });

  it("fallback updateWorkbench leaves assignment unchanged when unassign cannot clear snapshots", async () => {
    const createdAt = 1_800_000_000_560;
    await seedWorkspace(env.REGISTRY_DB, { workspaceId: "workspace-a", createdAt });
    await seedAgent(env.REGISTRY_DB, {
      workspaceId: "workspace-a",
      agentId: "agent-workspace-a",
      createdAt,
    });
    const db = drizzle(env.REGISTRY_DB, { schema });
    await seedEnvironment(db, { workbenchId: "env-a", workspaceId: "workspace-a", createdAt });
    await seedWorkspaceRepository(db, {
      repositoryId: "repo-a",
      workspaceId: "workspace-a",
      createdAt,
    });
    await assignRepositoriesToEnvironment(db, {
      workbenchId: "env-a",
      workspaceId: "workspace-a",
      repositoryIds: ["repo-a"],
      createdAt,
    });
    await new ThreadRepository(runTransactionsInline(db)).createWithWorkbench(
      {
        id: "thr_failed_unassign",
        workspaceId: "workspace-a",
        agentId: "agent-workspace-a",
        projectId: null,
        title: "Failed Unassign",
        titleSet: false,
        runtime: "legacy",
        source: "manual",
        automatonId: null,
        automatonRunId: null,
        lastEventId: null,
        lastMessagePreview: "",
        archivedAt: null,
        createdAt,
        updatedAt: createdAt,
      },
      "env-a",
    );

    await expect(
      new ThreadRepository(failSnapshotDeletes(forceUnsupportedTransactions(db))).updateWorkbench(
        "thr_failed_unassign",
        null,
        createdAt + 80,
      ),
    ).rejects.toThrow("snapshot_delete_failed");

    await expect(new ThreadRepository(db).getById("thr_failed_unassign")).resolves.toEqual(
      expect.objectContaining({ workbenchId: "env-a", updatedAt: createdAt }),
    );
    await expect(
      new ThreadRepositorySnapshotRepository(db).listForThread("thr_failed_unassign"),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "thr_failed_unassign:repo-a",
        workbenchId: "env-a",
      }),
    ]);
  });

  it("fallback updateWorkbench reconciles to unassigned when the trailing column update fails after snapshots commit", async () => {
    const createdAt = 1_800_000_000_570;
    await seedWorkspace(env.REGISTRY_DB, { workspaceId: "workspace-a", createdAt });
    await seedAgent(env.REGISTRY_DB, {
      workspaceId: "workspace-a",
      agentId: "agent-workspace-a",
      createdAt,
    });
    const db = drizzle(env.REGISTRY_DB, { schema });
    await seedEnvironment(db, { workbenchId: "env-a", workspaceId: "workspace-a", createdAt });
    await seedEnvironment(db, { workbenchId: "env-b", workspaceId: "workspace-a", createdAt });
    await seedWorkspaceRepository(db, {
      repositoryId: "repo-a",
      workspaceId: "workspace-a",
      createdAt,
    });
    await seedWorkspaceRepository(db, {
      repositoryId: "repo-b",
      workspaceId: "workspace-a",
      createdAt,
    });
    await assignRepositoriesToEnvironment(db, {
      workbenchId: "env-a",
      workspaceId: "workspace-a",
      repositoryIds: ["repo-a"],
      createdAt,
    });
    await assignRepositoriesToEnvironment(db, {
      workbenchId: "env-b",
      workspaceId: "workspace-a",
      repositoryIds: ["repo-b"],
      createdAt,
    });
    await new ThreadRepository(runTransactionsInline(db)).createWithWorkbench(
      {
        id: "thr_partial_move",
        workspaceId: "workspace-a",
        agentId: "agent-workspace-a",
        projectId: null,
        title: "Partial Move",
        titleSet: false,
        runtime: "legacy",
        source: "manual",
        automatonId: null,
        automatonRunId: null,
        lastEventId: null,
        lastMessagePreview: "",
        archivedAt: null,
        createdAt,
        updatedAt: createdAt,
      },
      "env-a",
    );

    // The snapshot phase (repo snapshots + environment snapshot for env-b)
    // fully commits; only the trailing threadIndex.workbenchId column
    // update fails. Without recovery this would leave the thread pointing at
    // env-a while its snapshots reflect env-b — a cross-environment
    // mismatch.
    await expect(
      new ThreadRepository(
        failFirstThreadIndexUpdate(forceUnsupportedTransactions(db)),
      ).updateWorkbench("thr_partial_move", "env-b", createdAt + 90),
    ).rejects.toThrow("thread_index_update_failed");

    await expect(new ThreadRepository(db).getById("thr_partial_move")).resolves.toEqual(
      expect.objectContaining({ workbenchId: null, updatedAt: createdAt + 90 }),
    );
    await expect(
      new ThreadRepositorySnapshotRepository(db).listForThread("thr_partial_move"),
    ).resolves.toEqual([]);
    await expect(
      new ThreadRepositorySnapshotRepository(db).listWorkbenchSnapshot("thr_partial_move"),
    ).resolves.toBeUndefined();
  });

  it("leaves the snapshot on the old workbench while a switch is pending", async () => {
    const createdAt = 1_800_000_000_575;
    await seedWorkspace(env.REGISTRY_DB, { workspaceId: "workspace-a", createdAt });
    await seedAgent(env.REGISTRY_DB, {
      workspaceId: "workspace-a",
      agentId: "agent-workspace-a",
      createdAt,
    });
    const db = drizzle(env.REGISTRY_DB, { schema });
    await seedEnvironment(db, { workbenchId: "wb_old", workspaceId: "workspace-a", createdAt });
    await seedEnvironment(db, { workbenchId: "wb_new", workspaceId: "workspace-a", createdAt });
    await new ThreadRepository(runTransactionsInline(db)).createWithWorkbench(
      {
        id: "thr_1",
        workspaceId: "workspace-a",
        agentId: "agent-workspace-a",
        projectId: null,
        title: "Pending Switch",
        titleSet: false,
        runtime: "legacy",
        source: "manual",
        automatonId: null,
        automatonRunId: null,
        lastEventId: null,
        lastMessagePreview: "",
        archivedAt: null,
        createdAt,
        updatedAt: createdAt,
      },
      "wb_old",
    );

    const repo = new ThreadRepository(db);
    await repo.beginWorkbenchSwitch("thr_1", "wb_new", 100);

    const thread = await db
      .select()
      .from(schema.threadIndex)
      .where(eq(schema.threadIndex.id, "thr_1"))
      .get();
    expect(thread?.workbenchId).toBe("wb_new");
    expect(thread?.workbenchSwitchPendingAt).toBe(100);

    const snapshot = await db
      .select()
      .from(schema.threadWorkbenchSnapshots)
      .where(eq(schema.threadWorkbenchSnapshots.threadId, "thr_1"))
      .get();
    expect(snapshot?.workbenchId).toBe("wb_old");
  });

  // Regression: the immediate `updateWorkbench` path never cleared the pending
  // marker. Reachable whenever the runtime is released (idle reaper /
  // `releaseIfReclaimable`) between a deferred switch and a second PATCH: the
  // thread is no longer live, so PATCH takes the immediate path and leaves the
  // marker armed. That permanently disables the picker AND leaves the turn-end
  // backstop primed to `execShutdown({confirm: true})` the next sandbox the
  // user acquires — destroying uncommitted work with no save-work prompt.
  it("updateWorkbench clears a pending switch marker left by an earlier deferred switch", async () => {
    const createdAt = 1_800_000_000_591;
    await seedWorkspace(env.REGISTRY_DB, { workspaceId: "workspace-a", createdAt });
    await seedAgent(env.REGISTRY_DB, {
      workspaceId: "workspace-a",
      agentId: "agent-workspace-a",
      createdAt,
    });
    const db = drizzle(env.REGISTRY_DB, { schema });
    await seedEnvironment(db, { workbenchId: "wb_old", workspaceId: "workspace-a", createdAt });
    await seedEnvironment(db, { workbenchId: "wb_new", workspaceId: "workspace-a", createdAt });
    await seedEnvironment(db, { workbenchId: "wb_third", workspaceId: "workspace-a", createdAt });
    await new ThreadRepository(runTransactionsInline(db)).createWithWorkbench(
      {
        id: "thr_stale_marker",
        workspaceId: "workspace-a",
        agentId: "agent-workspace-a",
        projectId: null,
        title: "Stale Marker",
        titleSet: false,
        runtime: "legacy",
        source: "manual",
        automatonId: null,
        automatonRunId: null,
        lastEventId: null,
        lastMessagePreview: "",
        archivedAt: null,
        createdAt,
        updatedAt: createdAt,
      },
      "wb_old",
    );

    const repo = new ThreadRepository(runTransactionsInline(db));
    await repo.beginWorkbenchSwitch("thr_stale_marker", "wb_new", 100);

    // The sandbox is released here in the real sequence, so the next PATCH
    // sees `isComputeLive() === false` and takes the immediate path.
    await repo.updateWorkbench("thr_stale_marker", "wb_third", 200);

    const thread = await db
      .select()
      .from(schema.threadIndex)
      .where(eq(schema.threadIndex.id, "thr_stale_marker"))
      .get();
    expect(thread?.workbenchId).toBe("wb_third");
    expect(thread?.workbenchSwitchPendingAt).toBeNull();

    // The immediate path moved the snapshot too, so there is nothing left to commit.
    const snapshot = await db
      .select()
      .from(schema.threadWorkbenchSnapshots)
      .where(eq(schema.threadWorkbenchSnapshots.threadId, "thr_stale_marker"))
      .get();
    expect(snapshot?.workbenchId).toBe("wb_third");
    expect(await repo.commitWorkbenchSwitch("thr_stale_marker", 300)).toBe(false);
  });

  // Same defect on the D1-transaction-unsupported fallback path.
  it("fallback updateWorkbench also clears a pending switch marker", async () => {
    const createdAt = 1_800_000_000_592;
    await seedWorkspace(env.REGISTRY_DB, { workspaceId: "workspace-a", createdAt });
    await seedAgent(env.REGISTRY_DB, {
      workspaceId: "workspace-a",
      agentId: "agent-workspace-a",
      createdAt,
    });
    const db = drizzle(env.REGISTRY_DB, { schema });
    await seedEnvironment(db, { workbenchId: "wb_old", workspaceId: "workspace-a", createdAt });
    await seedEnvironment(db, { workbenchId: "wb_new", workspaceId: "workspace-a", createdAt });
    await seedEnvironment(db, { workbenchId: "wb_third", workspaceId: "workspace-a", createdAt });
    await new ThreadRepository(runTransactionsInline(db)).createWithWorkbench(
      {
        id: "thr_stale_marker_fb",
        workspaceId: "workspace-a",
        agentId: "agent-workspace-a",
        projectId: null,
        title: "Stale Marker Fallback",
        titleSet: false,
        runtime: "legacy",
        source: "manual",
        automatonId: null,
        automatonRunId: null,
        lastEventId: null,
        lastMessagePreview: "",
        archivedAt: null,
        createdAt,
        updatedAt: createdAt,
      },
      "wb_old",
    );

    await new ThreadRepository(db).beginWorkbenchSwitch("thr_stale_marker_fb", "wb_new", 100);
    await new ThreadRepository(forceUnsupportedTransactions(db)).updateWorkbench(
      "thr_stale_marker_fb",
      "wb_third",
      200,
    );

    const thread = await db
      .select()
      .from(schema.threadIndex)
      .where(eq(schema.threadIndex.id, "thr_stale_marker_fb"))
      .get();
    expect(thread?.workbenchId).toBe("wb_third");
    expect(thread?.workbenchSwitchPendingAt).toBeNull();
  });

  it("commits once, then refuses when no switch is pending", async () => {
    const createdAt = 1_800_000_000_576;
    await seedWorkspace(env.REGISTRY_DB, { workspaceId: "workspace-a", createdAt });
    await seedAgent(env.REGISTRY_DB, {
      workspaceId: "workspace-a",
      agentId: "agent-workspace-a",
      createdAt,
    });
    const db = drizzle(env.REGISTRY_DB, { schema });
    await seedEnvironment(db, { workbenchId: "wb_old", workspaceId: "workspace-a", createdAt });
    await seedEnvironment(db, { workbenchId: "wb_new", workspaceId: "workspace-a", createdAt });
    await new ThreadRepository(runTransactionsInline(db)).createWithWorkbench(
      {
        id: "thr_1",
        workspaceId: "workspace-a",
        agentId: "agent-workspace-a",
        projectId: null,
        title: "Commit Switch",
        titleSet: false,
        runtime: "legacy",
        source: "manual",
        automatonId: null,
        automatonRunId: null,
        lastEventId: null,
        lastMessagePreview: "",
        archivedAt: null,
        createdAt,
        updatedAt: createdAt,
      },
      "wb_old",
    );

    const repo = new ThreadRepository(db);
    await repo.beginWorkbenchSwitch("thr_1", "wb_new", 100);

    expect(await repo.commitWorkbenchSwitch("thr_1", 200)).toBe(true);
    // Marker already cleared: BOTH the changes()-based path and the read-back
    // fallback must refuse here. This is the guard against a double teardown.
    expect(await repo.commitWorkbenchSwitch("thr_1", 201)).toBe(false);

    const snapshot = await db
      .select()
      .from(schema.threadWorkbenchSnapshots)
      .where(eq(schema.threadWorkbenchSnapshots.threadId, "thr_1"))
      .get();
    expect(snapshot?.workbenchId).toBe("wb_new");
  });

  it("leaves the switch pending and retryable when the re-snapshot fails", async () => {
    const createdAt = 1_800_000_000_577;
    await seedWorkspace(env.REGISTRY_DB, { workspaceId: "workspace-a", createdAt });
    await seedAgent(env.REGISTRY_DB, {
      workspaceId: "workspace-a",
      agentId: "agent-workspace-a",
      createdAt,
    });
    const db = drizzle(env.REGISTRY_DB, { schema });
    await seedEnvironment(db, { workbenchId: "wb_old", workspaceId: "workspace-a", createdAt });
    await seedEnvironment(db, { workbenchId: "wb_new", workspaceId: "workspace-a", createdAt });
    await new ThreadRepository(runTransactionsInline(db)).createWithWorkbench(
      {
        id: "thr_1",
        workspaceId: "workspace-a",
        agentId: "agent-workspace-a",
        projectId: null,
        title: "Retryable Switch",
        titleSet: false,
        runtime: "legacy",
        source: "manual",
        automatonId: null,
        automatonRunId: null,
        lastEventId: null,
        lastMessagePreview: "",
        archivedAt: null,
        createdAt,
        updatedAt: createdAt,
      },
      "wb_old",
    );

    const repo = new ThreadRepository(db);
    await repo.beginWorkbenchSwitch("thr_1", "wb_new", 100);

    const faultyRepo = new ThreadRepository(failSnapshotDeletes(db));
    await expect(faultyRepo.commitWorkbenchSwitch("thr_1", 200)).rejects.toThrow(
      "snapshot_delete_failed",
    );

    // The permit must still be set: a failed re-snapshot must not burn it.
    const afterFailure = await db
      .select()
      .from(schema.threadIndex)
      .where(eq(schema.threadIndex.id, "thr_1"))
      .get();
    expect(afterFailure?.workbenchSwitchPendingAt).toBe(100);

    // With the fault removed, the same commit call succeeds and lands the
    // snapshot on the new workbench.
    expect(await repo.commitWorkbenchSwitch("thr_1", 201)).toBe(true);

    const afterRetry = await db
      .select()
      .from(schema.threadIndex)
      .where(eq(schema.threadIndex.id, "thr_1"))
      .get();
    expect(afterRetry?.workbenchSwitchPendingAt).toBe(null);

    const snapshot = await db
      .select()
      .from(schema.threadWorkbenchSnapshots)
      .where(eq(schema.threadWorkbenchSnapshots.threadId, "thr_1"))
      .get();
    expect(snapshot?.workbenchId).toBe("wb_new");
  });

  it("no-op commit when nothing is pending does not rewrite the snapshot", async () => {
    const createdAt = 1_800_000_000_578;
    await seedWorkspace(env.REGISTRY_DB, { workspaceId: "workspace-a", createdAt });
    await seedAgent(env.REGISTRY_DB, {
      workspaceId: "workspace-a",
      agentId: "agent-workspace-a",
      createdAt,
    });
    const db = drizzle(env.REGISTRY_DB, { schema });
    await seedEnvironment(db, { workbenchId: "wb_old", workspaceId: "workspace-a", createdAt });
    await new ThreadRepository(runTransactionsInline(db)).createWithWorkbench(
      {
        id: "thr_1",
        workspaceId: "workspace-a",
        agentId: "agent-workspace-a",
        projectId: null,
        title: "No Pending Switch",
        titleSet: false,
        runtime: "legacy",
        source: "manual",
        automatonId: null,
        automatonRunId: null,
        lastEventId: null,
        lastMessagePreview: "",
        archivedAt: null,
        createdAt,
        updatedAt: createdAt,
      },
      "wb_old",
    );

    const before = await db
      .select()
      .from(schema.threadWorkbenchSnapshots)
      .where(eq(schema.threadWorkbenchSnapshots.threadId, "thr_1"))
      .get();

    const repo = new ThreadRepository(db);
    expect(await repo.commitWorkbenchSwitch("thr_1", 999)).toBe(false);

    const after = await db
      .select()
      .from(schema.threadWorkbenchSnapshots)
      .where(eq(schema.threadWorkbenchSnapshots.threadId, "thr_1"))
      .get();
    expect(after).toStrictEqual(before);
  });

  it("commit fallback: commits when the marker was genuinely cleared and meta.changes is unreadable", async () => {
    const createdAt = 1_800_000_000_579;
    await seedWorkspace(env.REGISTRY_DB, { workspaceId: "workspace-a", createdAt });
    await seedAgent(env.REGISTRY_DB, {
      workspaceId: "workspace-a",
      agentId: "agent-workspace-a",
      createdAt,
    });
    const db = drizzle(env.REGISTRY_DB, { schema });
    await seedEnvironment(db, { workbenchId: "wb_old", workspaceId: "workspace-a", createdAt });
    await seedEnvironment(db, { workbenchId: "wb_new", workspaceId: "workspace-a", createdAt });
    await new ThreadRepository(runTransactionsInline(db)).createWithWorkbench(
      {
        id: "thr_unreadable_changes",
        workspaceId: "workspace-a",
        agentId: "agent-workspace-a",
        projectId: null,
        title: "Unreadable Changes",
        titleSet: false,
        runtime: "legacy",
        source: "manual",
        automatonId: null,
        automatonRunId: null,
        lastEventId: null,
        lastMessagePreview: "",
        archivedAt: null,
        createdAt,
        updatedAt: createdAt,
      },
      "wb_old",
    );

    const repo = new ThreadRepository(db);
    await repo.beginWorkbenchSwitch("thr_unreadable_changes", "wb_new", 100);

    // meta.changes is forced null even though the write really landed, so the
    // read-back fallback is the only thing that can confirm the commit.
    const fallbackRepo = new ThreadRepository(nullOutThreadIndexChangeCount(db));
    expect(await fallbackRepo.commitWorkbenchSwitch("thr_unreadable_changes", 200)).toBe(true);

    const thread = await db
      .select()
      .from(schema.threadIndex)
      .where(eq(schema.threadIndex.id, "thr_unreadable_changes"))
      .get();
    expect(thread?.workbenchSwitchPendingAt).toBeNull();

    const snapshot = await db
      .select()
      .from(schema.threadWorkbenchSnapshots)
      .where(eq(schema.threadWorkbenchSnapshots.threadId, "thr_unreadable_changes"))
      .get();
    expect(snapshot?.workbenchId).toBe("wb_new");
  });

  it("commit fallback: refuses a second commit once nothing is pending, even with unreadable meta.changes", async () => {
    const createdAt = 1_800_000_000_580;
    await seedWorkspace(env.REGISTRY_DB, { workspaceId: "workspace-a", createdAt });
    await seedAgent(env.REGISTRY_DB, {
      workspaceId: "workspace-a",
      agentId: "agent-workspace-a",
      createdAt,
    });
    const db = drizzle(env.REGISTRY_DB, { schema });
    await seedEnvironment(db, { workbenchId: "wb_old", workspaceId: "workspace-a", createdAt });
    await seedEnvironment(db, { workbenchId: "wb_new", workspaceId: "workspace-a", createdAt });
    await new ThreadRepository(runTransactionsInline(db)).createWithWorkbench(
      {
        id: "thr_no_spurious_commit",
        workspaceId: "workspace-a",
        agentId: "agent-workspace-a",
        projectId: null,
        title: "No Spurious Commit",
        titleSet: false,
        runtime: "legacy",
        source: "manual",
        automatonId: null,
        automatonRunId: null,
        lastEventId: null,
        lastMessagePreview: "",
        archivedAt: null,
        createdAt,
        updatedAt: createdAt,
      },
      "wb_old",
    );

    const fallbackRepo = new ThreadRepository(nullOutThreadIndexChangeCount(db));
    await fallbackRepo.beginWorkbenchSwitch("thr_no_spurious_commit", "wb_new", 100);

    // First call: real write clears the marker; unreadable meta.changes forces
    // the read-back, which confirms it and commits.
    expect(await fallbackRepo.commitWorkbenchSwitch("thr_no_spurious_commit", 200)).toBe(true);

    // Second call: nothing is pending anymore. If the fallback's read-back
    // ever treated "no pending switch" as a success, this would spuriously
    // return true and re-run the (idempotent but wasteful) teardown a second
    // time — the exact double-commit the read-back is supposed to prevent.
    expect(await fallbackRepo.commitWorkbenchSwitch("thr_no_spurious_commit", 201)).toBe(false);
  });

  it("listForWorkspace filters to unassigned threads", async () => {
    const createdAt = 1_800_000_000_600;
    await seedWorkspace(env.REGISTRY_DB, { workspaceId: "workspace-a", createdAt });
    const db = drizzle(env.REGISTRY_DB, { schema });
    await seedProject(db, { projectId: "project-a", workspaceId: "workspace-a", createdAt });

    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-a",
      threadId: "thr_unassigned_list",
      projectId: null,
      updatedAt: createdAt + 1,
    });
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-a",
      threadId: "thr_project_list",
      projectId: "project-a",
      updatedAt: createdAt + 2,
    });

    await expect(
      new ThreadRepository(db).listForWorkspace("workspace-a", {
        status: "all",
        project: { kind: "unassigned" },
      }),
    ).resolves.toEqual([expect.objectContaining({ id: "thr_unassigned_list", projectId: null })]);
  });

  it("listForWorkspace filters to a specific project", async () => {
    const createdAt = 1_800_000_000_700;
    await seedWorkspace(env.REGISTRY_DB, { workspaceId: "workspace-a", createdAt });
    const db = drizzle(env.REGISTRY_DB, { schema });
    await seedProject(db, { projectId: "project-a", workspaceId: "workspace-a", createdAt });
    await seedProject(db, { projectId: "project-b", workspaceId: "workspace-a", createdAt });

    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-a",
      threadId: "thr_project_a_list",
      projectId: "project-a",
      updatedAt: createdAt + 1,
    });
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-a",
      threadId: "thr_project_b_list",
      projectId: "project-b",
      updatedAt: createdAt + 2,
    });
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-a",
      threadId: "thr_project_null_list",
      projectId: null,
      updatedAt: createdAt + 3,
    });

    const rows = await new ThreadRepository(db).listForWorkspace("workspace-a", {
      status: "all",
      project: { kind: "project", projectId: "project-a" },
    });

    expect(rows).toEqual([
      expect.objectContaining({ id: "thr_project_a_list", projectId: "project-a" }),
    ]);
    const snapshotCounts = await new ThreadRepositorySnapshotRepository(db).countForThreads(
      rows.map((row) => row.id),
    );
    expect(snapshotCounts).toEqual(new Map([["thr_project_a_list", 0]]));
  });

  it("snapshot counts can be queried for multiple threads", async () => {
    const createdAt = 1_800_000_000_800;
    await seedWorkspace(env.REGISTRY_DB, { workspaceId: "workspace-a", createdAt });
    const db = drizzle(env.REGISTRY_DB, { schema });
    await seedEnvironment(db, { workbenchId: "env-a", workspaceId: "workspace-a", createdAt });
    await seedWorkspaceRepository(db, {
      repositoryId: "repo-a",
      workspaceId: "workspace-a",
      createdAt,
    });
    await assignRepositoriesToEnvironment(db, {
      workbenchId: "env-a",
      workspaceId: "workspace-a",
      repositoryIds: ["repo-a"],
      createdAt,
    });
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-a",
      threadId: "thr_count_a",
      createdAt,
      updatedAt: createdAt,
    });
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-a",
      threadId: "thr_count_b",
      createdAt,
      updatedAt: createdAt,
    });

    const snapshots = new ThreadRepositorySnapshotRepository(db);
    await snapshots.replaceFromWorkbench("thr_count_a", "workspace-a", "env-a", createdAt);

    const counts = await snapshots.countForThreads(["thr_count_a", "thr_count_b"]);
    expect(counts).toEqual(
      new Map([
        ["thr_count_a", 1],
        ["thr_count_b", 0],
      ]),
    );

    const rawRows = await db
      .select()
      .from(schema.threadRepositorySnapshots)
      .where(eq(schema.threadRepositorySnapshots.threadId, "thr_count_a"))
      .orderBy(asc(schema.threadRepositorySnapshots.id))
      .all();
    expect(rawRows).toHaveLength(1);
  });
});
