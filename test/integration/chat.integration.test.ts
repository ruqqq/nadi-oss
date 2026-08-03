import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveThreadRuntimeConfigForAgent } from "../../src/agent/thread-agent-config";
import { WorkbenchRepository } from "../../src/db/repositories/workbenches";
import { ProjectRepository } from "../../src/db/repositories/projects";
import { ThreadRepositorySnapshotRepository } from "../../src/db/repositories/thread-repository-snapshots";
import * as schema from "../../src/db/schema";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";

async function seedProjectRuntimeContext() {
  const db = drizzle(env.REGISTRY_DB, { schema });
  const createdAt = 1_800_000_100_000;

  await env.REGISTRY_DB.prepare(
    "INSERT OR IGNORE INTO workspaces (id, name, created_at) VALUES (?, ?, ?)",
  )
    .bind("workspace-project-runtime", "workspace-project-runtime", createdAt)
    .run();
  await env.REGISTRY_DB.prepare(
    "INSERT OR IGNORE INTO agents (id, workspace_id, name, system_prompt, provider, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      "agent-workspace-project-runtime",
      "workspace-project-runtime",
      "Default",
      "You are Nadi.",
      "mock",
      "mock",
      createdAt,
    )
    .run();

  await new ProjectRepository(db).create({
    id: "project-runtime",
    workspaceId: "workspace-project-runtime",
    name: "Nadi",
    description: "Main app",
    customInstructions: "Prefer focused tests.",
    createdAt,
    updatedAt: createdAt,
  });
  await new WorkbenchRepository(db).create({
    id: "env-runtime",
    workspaceId: "workspace-project-runtime",
    name: "Runtime env",
    description: "",
    setupScript: "",
    sandboxEnvVarsJson: "{}",
    createdAt,
    updatedAt: createdAt,
  });
  await new WorkbenchRepository(db).replaceRepositories(
    "env-runtime",
    "workspace-project-runtime",
    [
      {
        source: "url",
        name: "nadi",
        url: "https://github.com/acme/nadi.git",
        defaultBranch: "main",
        checkoutPathName: "nadi",
        rootDirectory: "/",
        setupCommand: "pnpm install",
        packageManager: "pnpm",
      },
    ],
    createdAt,
  );
  await seedRegistryThread(env.REGISTRY_DB, {
    workspaceId: "workspace-project-runtime",
    agentId: "agent-workspace-project-runtime",
    threadId: "legacy-project-runtime",
    projectId: "project-runtime",
    createdAt,
    updatedAt: createdAt,
  });
  await seedRegistryThread(env.REGISTRY_DB, {
    workspaceId: "workspace-project-runtime",
    agentId: "agent-workspace-project-runtime",
    threadId: "legacy-unassigned-runtime",
    projectId: null,
    createdAt: createdAt + 1,
    updatedAt: createdAt + 1,
  });
  await new ThreadRepositorySnapshotRepository(db).replaceFromWorkbench(
    "legacy-project-runtime",
    "workspace-project-runtime",
    "env-runtime",
    createdAt,
  );
}

beforeAll(async () => {
  await applyRegistryTestSchema(env.REGISTRY_DB);
  await seedRegistryThread(env.REGISTRY_DB, { threadId: "legacy-stub-thread" });
  await seedProjectRuntimeContext();
});

describe("thread runtime config", () => {
  it("resolves registry config for an existing thread row", async () => {
    const config = await resolveThreadRuntimeConfigForAgent(env, "legacy-stub-thread");

    expect({
      workspaceId: config?.workspaceId,
      agentId: config?.agentId,
      provider: config?.modelConfig.provider,
    }).toMatchObject({
      workspaceId: "workspace-test",
      agentId: "agent-workspace-test",
      provider: "mock",
    });
  });

  it("returns no project prompt context for unassigned threads", async () => {
    const config = await resolveThreadRuntimeConfigForAgent(env, "legacy-unassigned-runtime");

    expect(config?.projectContext).toBeUndefined();
  });

  it("returns structured project prompt context for assigned threads", async () => {
    const config = await resolveThreadRuntimeConfigForAgent(env, "legacy-project-runtime");

    expect(config?.projectContext).toEqual({
      name: "Nadi",
      description: "Main app",
      instructions: "Prefer focused tests.",
      repositories: [
        {
          name: "nadi",
          url: "https://github.com/acme/nadi.git",
          defaultBranch: "main",
          checkoutPath: "nadi",
          rootDirectory: "/",
          setupCommand: "pnpm install",
          packageManager: "pnpm",
        },
      ],
    });
  });
});
