import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ProjectRepository } from "../../src/db/repositories/projects";
import * as schema from "../../src/db/schema";
import { applyRegistryTestSchema } from "./helpers/registry";

async function seedWorkspace(
  registryDb: typeof env.REGISTRY_DB,
  input: { workspaceId: string; createdAt?: number },
) {
  await registryDb
    .prepare("INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)")
    .bind(input.workspaceId, input.workspaceId, input.createdAt ?? 1)
    .run();
}

describe("ProjectRepository", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  afterEach(async () => {
    await env.REGISTRY_DB.prepare("DELETE FROM projects").run();
    await env.REGISTRY_DB.prepare("DELETE FROM workspaces").run();
  });

  beforeEach(async () => {
    await env.REGISTRY_DB.prepare("DELETE FROM projects").run();
    await env.REGISTRY_DB.prepare("DELETE FROM workspaces").run();
  });

  it("creates and lists active projects for a workspace", async () => {
    await seedWorkspace(env.REGISTRY_DB, { workspaceId: "workspace-a", createdAt: 10 });
    const db = drizzle(env.REGISTRY_DB, { schema });
    const repo = new ProjectRepository(db);

    await repo.create({
      id: "project-1",
      workspaceId: "workspace-a",
      name: "Nadi",
      description: "Main app",
      customInstructions: "Prefer focused tests.",
      createdAt: 10,
      updatedAt: 10,
    });

    await expect(repo.listForWorkspace("workspace-a")).resolves.toEqual([
      expect.objectContaining({ id: "project-1", archivedAt: null }),
    ]);
  });

  it("returns persisted defaulted fields from create", async () => {
    await seedWorkspace(env.REGISTRY_DB, { workspaceId: "workspace-a", createdAt: 10 });
    const db = drizzle(env.REGISTRY_DB, { schema });
    const repo = new ProjectRepository(db);

    await expect(
      repo.create({
        id: "project-1",
        workspaceId: "workspace-a",
        name: "Nadi",
        createdAt: 10,
        updatedAt: 10,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        id: "project-1",
        description: "",
        customInstructions: "",
        archivedAt: null,
      }),
    );
  });

  it("updates editable fields", async () => {
    await seedWorkspace(env.REGISTRY_DB, { workspaceId: "workspace-a", createdAt: 10 });
    const db = drizzle(env.REGISTRY_DB, { schema });
    const repo = new ProjectRepository(db);

    await repo.create({
      id: "project-1",
      workspaceId: "workspace-a",
      name: "Nadi",
      description: "Main app",
      customInstructions: "Prefer focused tests.",
      createdAt: 10,
      updatedAt: 10,
    });

    await repo.update("project-1", {
      name: "Nadi Core",
      description: "Updated app",
      customInstructions: "Keep repository tests focused.",
      updatedAt: 20,
    });

    await expect(repo.getById("project-1")).resolves.toEqual(
      expect.objectContaining({
        name: "Nadi Core",
        description: "Updated app",
        customInstructions: "Keep repository tests focused.",
        updatedAt: 20,
      }),
    );
  });

  it("archives rows from active listings and includes them in archived listings", async () => {
    await seedWorkspace(env.REGISTRY_DB, { workspaceId: "workspace-a", createdAt: 10 });
    const db = drizzle(env.REGISTRY_DB, { schema });
    const repo = new ProjectRepository(db);

    await repo.create({
      id: "project-1",
      workspaceId: "workspace-a",
      name: "Nadi",
      description: "Main app",
      customInstructions: "",
      createdAt: 10,
      updatedAt: 10,
    });

    await repo.archive("project-1", 30);

    await expect(repo.listForWorkspace("workspace-a")).resolves.toEqual([]);
    await expect(repo.listForWorkspace("workspace-a", "archived")).resolves.toEqual([
      expect.objectContaining({ id: "project-1", archivedAt: 30 }),
    ]);
  });

  it("rejects cross-workspace assertions", async () => {
    await seedWorkspace(env.REGISTRY_DB, { workspaceId: "workspace-a", createdAt: 10 });
    await seedWorkspace(env.REGISTRY_DB, { workspaceId: "workspace-b", createdAt: 10 });
    const db = drizzle(env.REGISTRY_DB, { schema });
    const repo = new ProjectRepository(db);

    await repo.create({
      id: "project-1",
      workspaceId: "workspace-a",
      name: "Nadi",
      description: "",
      customInstructions: "",
      createdAt: 10,
      updatedAt: 10,
    });

    await expect(repo.assertProjectInWorkspace("project-1", "workspace-b")).rejects.toThrow(
      "project_not_found",
    );
    await expect(repo.assertActiveProjectInWorkspace("project-1", "workspace-b")).rejects.toThrow(
      "project_not_found",
    );
  });
});
