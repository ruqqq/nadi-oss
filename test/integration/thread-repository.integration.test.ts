import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WorkbenchRepository } from "../../src/db/repositories/workbenches";
import { ProjectRepository } from "../../src/db/repositories/projects";
import * as schema from "../../src/db/schema";
import { ThreadRepository } from "../../src/db/repositories/threads";
import { serializeThread } from "../../src/http/thread-serialize";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";

type TestDb = DrizzleD1Database<typeof schema>;

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
    await db.insert(schema.agentRepositories).values({
      id: repositoryId,
      agentId: input.workbenchId,
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
    await drizzle(env.REGISTRY_DB, { schema }).delete(schema.threadIndex);
    await drizzle(env.REGISTRY_DB, { schema }).delete(schema.agentRepositories);
    await drizzle(env.REGISTRY_DB, { schema }).delete(schema.workbenches);
    await drizzle(env.REGISTRY_DB, { schema }).delete(schema.projects);
    await drizzle(env.REGISTRY_DB, { schema }).delete(schema.agents);
    await drizzle(env.REGISTRY_DB, { schema }).delete(schema.workspaces);
  });
  afterEach(async () => {
    await drizzle(env.REGISTRY_DB, { schema }).delete(schema.threadIndex);
    await drizzle(env.REGISTRY_DB, { schema }).delete(schema.agentRepositories);
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

  it("createWithWorkbench with null leaves the thread unassigned", async () => {
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
  });

  it("createWithWorkbench with an environment persists the assignment", async () => {
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
    // The environment's repositories are read LIVE at use time; nothing is
    // copied onto the thread.
    await expect(new WorkbenchRepository(db).listRepositories("env-a")).resolves.toEqual([
      expect.objectContaining({ id: "repo-a", agentId: "env-a" }),
    ]);
  });

  it("getSummaryRowById enriches the thread with projectName and the live repository count", async () => {
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

  it("getSummaryRowById reports the LIVE environment resourceProfile and a repository count unaffected by the join", async () => {
    const createdAt = 1_800_000_000_960;
    await seedWorkspace(env.REGISTRY_DB, { workspaceId: "workspace-a", createdAt });
    await seedAgent(env.REGISTRY_DB, {
      workspaceId: "workspace-a",
      agentId: "agent-workspace-a",
      createdAt,
    });
    const db = drizzle(env.REGISTRY_DB, { schema });

    await seedEnvironment(db, {
      workbenchId: "env-old",
      workspaceId: "workspace-a",
      resourceProfile: "small",
      createdAt,
    });
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

    // Two repositories: the multi-row case that would expose a
    // row-multiplying join on the profile.
    const onOld = await new ThreadRepository(db).getSummaryRowById("thr_mid_switch");
    expect(onOld?.snapshotResourceProfile).toBe("small");
    expect(onOld?.repositorySnapshotCount).toBe(2);

    // Retarget: configuration is LIVE, so the reported profile follows
    // immediately, with no snapshot and no handshake.
    await new ThreadRepository(db).updateWorkbench("thr_mid_switch", "env-new", createdAt + 1);

    const row = await new ThreadRepository(db).getSummaryRowById("thr_mid_switch");
    expect(row).toBeTruthy();
    expect(row?.workbenchId).toBe("env-new");
    expect(row?.snapshotResourceProfile).toBe("medium");
    // env-new has no repositories, so the count follows the live list too.
    expect(row?.repositorySnapshotCount).toBe(0);

    const summary = serializeThread(row!);
    expect(summary.resourceProfile).toBe("medium");
    expect(summary.repositorySnapshotCount).toBe(0);
  });

  it("updateProject only changes the project label, leaving the environment untouched", async () => {
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
  });

  it("updateWorkbench moves the thread to another environment", async () => {
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
    // The move changes only the pointer: env-b's repositories are its own and
    // are read live, and env-a's are untouched.
    await expect(new WorkbenchRepository(db).listRepositories("env-b")).resolves.toEqual([
      expect.objectContaining({ id: "repo-b" }),
    ]);
    await expect(new WorkbenchRepository(db).listRepositories("env-a")).resolves.toEqual([
      expect.objectContaining({ id: "repo-a" }),
    ]);
  });

  it("updateWorkbench unassigns the thread's environment", async () => {
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
    // Unassigning never deletes the environment's own repositories.
    await expect(new WorkbenchRepository(db).listRepositories("env-a")).resolves.toEqual([
      expect.objectContaining({ id: "repo-a" }),
    ]);
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
  });
});
