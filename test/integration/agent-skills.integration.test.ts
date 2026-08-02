import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AgentSkillRepository } from "../../src/db/repositories/agent-skills";
import { createBuiltinSkillSource } from "../../src/agent/skills/builtin-skill-source";
import { createD1SkillSource } from "../../src/agent/skills/d1-skill-source";
import * as schema from "../../src/db/schema";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";

async function clearSkills() {
  await drizzle(env.REGISTRY_DB, { schema }).delete(schema.agentSkills);
}

describe("AgentSkillRepository", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  beforeEach(async () => {
    await clearSkills();
  });

  it("creates and lists active skills for an agent", async () => {
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-a",
      agentId: "agent-a",
      threadId: "thread-a",
    });
    const repo = new AgentSkillRepository(drizzle(env.REGISTRY_DB, { schema }));

    const created = await repo.create({
      workspaceId: "workspace-a",
      agentId: "agent-a",
      name: "Code Review",
      description: "Review code with small commits.",
      body: "Prefer focused findings and small commits.",
    });

    expect(created).toMatchObject({
      workspaceId: "workspace-a",
      agentId: "agent-a",
      name: "code-review",
      description: "Review code with small commits.",
      body: "Prefer focused findings and small commits.",
      archivedAt: null,
    });
    await expect(
      repo.getActiveByName({
        workspaceId: "workspace-a",
        agentId: "agent-a",
        name: "Code Review",
      }),
    ).resolves.toMatchObject({ id: created.id, name: "code-review" });
    await expect(
      repo.listActive({ workspaceId: "workspace-a", agentId: "agent-a" }),
    ).resolves.toMatchObject([{ id: created.id, name: "code-review" }]);
  });

  it("edits, archives, and recreates a soft-deleted skill", async () => {
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-a",
      agentId: "agent-a",
      threadId: "thread-a",
    });
    const repo = new AgentSkillRepository(drizzle(env.REGISTRY_DB, { schema }));

    await repo.create({
      workspaceId: "workspace-a",
      agentId: "agent-a",
      name: "deploy notes",
      description: "Original",
      body: "Original body",
    });
    const edited = await repo.edit({
      workspaceId: "workspace-a",
      agentId: "agent-a",
      name: "deploy notes",
      newName: "deployment",
      description: "Updated",
      body: "Updated body",
    });

    expect(edited).toMatchObject({
      name: "deployment",
      description: "Updated",
      body: "Updated body",
    });
    await expect(
      repo.archive({ workspaceId: "workspace-a", agentId: "agent-a", name: "deployment" }),
    ).resolves.toBe(true);
    await expect(
      repo.listActive({ workspaceId: "workspace-a", agentId: "agent-a" }),
    ).resolves.toEqual([]);
    await expect(
      repo.getActiveByName({ workspaceId: "workspace-a", agentId: "agent-a", name: "deployment" }),
    ).resolves.toBeUndefined();

    const recreated = await repo.create({
      workspaceId: "workspace-a",
      agentId: "agent-a",
      name: "deployment",
      description: "Recreated",
      body: "Recreated body",
    });
    expect(recreated.name).toBe("deployment");
  });

  it("rejects invalid names and duplicate active names", async () => {
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-a",
      agentId: "agent-a",
      threadId: "thread-a",
    });
    const repo = new AgentSkillRepository(drizzle(env.REGISTRY_DB, { schema }));

    await expect(
      repo.create({
        workspaceId: "workspace-a",
        agentId: "agent-a",
        name: "../secret",
        description: "Invalid",
        body: "Invalid",
      }),
    ).rejects.toThrow("invalid skill name");

    await repo.create({
      workspaceId: "workspace-a",
      agentId: "agent-a",
      name: "review",
      description: "Review",
      body: "Review body",
    });
    await expect(
      repo.create({
        workspaceId: "workspace-a",
        agentId: "agent-a",
        name: "Review",
        description: "Duplicate",
        body: "Duplicate body",
      }),
    ).rejects.toThrow("duplicate skill name");
  });

  it("isolates skills by agent and workspace", async () => {
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-a",
      agentId: "agent-a",
      threadId: "thread-a",
    });
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-a",
      agentId: "agent-b",
      threadId: "thread-b",
    });
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-b",
      agentId: "agent-a",
      threadId: "thread-c",
    });
    const repo = new AgentSkillRepository(drizzle(env.REGISTRY_DB, { schema }));

    await repo.create({
      workspaceId: "workspace-a",
      agentId: "agent-a",
      name: "review",
      description: "A",
      body: "A body",
    });
    await repo.create({
      workspaceId: "workspace-a",
      agentId: "agent-b",
      name: "review",
      description: "B",
      body: "B body",
    });
    await repo.create({
      workspaceId: "workspace-b",
      agentId: "agent-a",
      name: "review",
      description: "C",
      body: "C body",
    });

    await expect(
      repo.listActive({ workspaceId: "workspace-a", agentId: "agent-a" }),
    ).resolves.toMatchObject([{ description: "A", body: "A body" }]);
    await expect(
      repo.listActive({ workspaceId: "workspace-a", agentId: "agent-b" }),
    ).resolves.toMatchObject([{ description: "B", body: "B body" }]);
    await expect(
      repo.listActive({ workspaceId: "workspace-b", agentId: "agent-a" }),
    ).resolves.toMatchObject([{ description: "C", body: "C body" }]);
  });

  it("defaults new skills to enabled and excludes disabled from listActive", async () => {
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-a",
      agentId: "agent-a",
      threadId: "thread-a",
    });
    const repo = new AgentSkillRepository(drizzle(env.REGISTRY_DB, { schema }));

    const created = await repo.create({
      workspaceId: "workspace-a",
      agentId: "agent-a",
      name: "review",
      description: "Review",
      body: "Review body",
    });
    expect(created.enabled).toBe(true);

    const disabled = await repo.setEnabled({
      workspaceId: "workspace-a",
      agentId: "agent-a",
      id: created.id,
      enabled: false,
    });
    expect(disabled?.enabled).toBe(false);

    await expect(
      repo.listActive({ workspaceId: "workspace-a", agentId: "agent-a" }),
    ).resolves.toEqual([]);
    await expect(
      repo.listActive(
        { workspaceId: "workspace-a", agentId: "agent-a" },
        { includeDisabled: true },
      ),
    ).resolves.toMatchObject([{ id: created.id, enabled: false }]);
  });

  it("archives by id, lists archived, and restores", async () => {
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-a",
      agentId: "agent-a",
      threadId: "thread-a",
    });
    const repo = new AgentSkillRepository(drizzle(env.REGISTRY_DB, { schema }));

    const created = await repo.create({
      workspaceId: "workspace-a",
      agentId: "agent-a",
      name: "deploy",
      description: "Deploy",
      body: "Deploy body",
    });

    const archived = await repo.archiveById({
      workspaceId: "workspace-a",
      agentId: "agent-a",
      id: created.id,
    });
    expect(archived?.archivedAt).not.toBeNull();
    await expect(
      repo.listActive(
        { workspaceId: "workspace-a", agentId: "agent-a" },
        { includeDisabled: true },
      ),
    ).resolves.toEqual([]);
    await expect(
      repo.listArchived({ workspaceId: "workspace-a", agentId: "agent-a" }),
    ).resolves.toMatchObject([{ id: created.id }]);

    const restored = await repo.restore({
      workspaceId: "workspace-a",
      agentId: "agent-a",
      id: created.id,
    });
    expect(restored?.archivedAt).toBeNull();
  });

  it("refuses to restore when an active skill reuses the name", async () => {
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-a",
      agentId: "agent-a",
      threadId: "thread-a",
    });
    const repo = new AgentSkillRepository(drizzle(env.REGISTRY_DB, { schema }));

    const first = await repo.create({
      workspaceId: "workspace-a",
      agentId: "agent-a",
      name: "notes",
      description: "First",
      body: "First body",
    });
    await repo.archiveById({ workspaceId: "workspace-a", agentId: "agent-a", id: first.id });
    await repo.create({
      workspaceId: "workspace-a",
      agentId: "agent-a",
      name: "notes",
      description: "Second",
      body: "Second body",
    });

    await expect(
      repo.restore({ workspaceId: "workspace-a", agentId: "agent-a", id: first.id }),
    ).rejects.toThrow("duplicate skill name");
  });

  it("does not mutate a real skill owned by another workspace/agent", async () => {
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-a",
      agentId: "agent-a",
      threadId: "thread-a",
    });
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-b",
      agentId: "agent-b",
      threadId: "thread-b",
    });
    const repo = new AgentSkillRepository(drizzle(env.REGISTRY_DB, { schema }));

    // A genuine skill owned by workspace-b / agent-b.
    const foreign = await repo.create({
      workspaceId: "workspace-b",
      agentId: "agent-b",
      name: "secret",
      description: "Owned by B",
      body: "B body",
    });

    // workspace-a / agent-a supplies the real foreign id — every lifecycle op
    // must miss (scoped by workspace+agent), leaving the foreign skill intact.
    await expect(
      repo.setEnabled({
        workspaceId: "workspace-a",
        agentId: "agent-a",
        id: foreign.id,
        enabled: false,
      }),
    ).resolves.toBeUndefined();
    await expect(
      repo.archiveById({ workspaceId: "workspace-a", agentId: "agent-a", id: foreign.id }),
    ).resolves.toBeUndefined();
    await expect(
      repo.restore({ workspaceId: "workspace-a", agentId: "agent-a", id: foreign.id }),
    ).resolves.toBeUndefined();

    const stillThere = await repo.listActive(
      { workspaceId: "workspace-b", agentId: "agent-b" },
      { includeDisabled: true },
    );
    expect(stillThere).toMatchObject([{ id: foreign.id, enabled: true, archivedAt: null }]);
  });
});

describe("agent skill sources", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  beforeEach(async () => {
    await clearSkills();
  });

  it("lists and loads the built-in skill authoring source", async () => {
    const source = createBuiltinSkillSource(true);

    await expect(source.list()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "skill_authoring",
          description: expect.stringContaining("Nadi"),
        }),
      ]),
    );
    await expect(source.load("skill_authoring")).resolves.toMatchObject({
      name: "skill_authoring",
      body: expect.stringContaining("create_skill"),
    });
    await expect(source.load("missing")).resolves.toBeNull();
  });

  it("lists and loads active D1 skills for the resolved agent", async () => {
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-a",
      agentId: "agent-a",
      threadId: "thread-a",
    });
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-a",
      agentId: "agent-b",
      threadId: "thread-b",
    });
    const repo = new AgentSkillRepository(drizzle(env.REGISTRY_DB, { schema }));
    await repo.create({
      workspaceId: "workspace-a",
      agentId: "agent-a",
      name: "review",
      description: "Review code",
      body: "Review body",
    });
    await repo.create({
      workspaceId: "workspace-a",
      agentId: "agent-a",
      name: "archived",
      description: "Archived",
      body: "Archived body",
    });
    await repo.archive({ workspaceId: "workspace-a", agentId: "agent-a", name: "archived" });
    await repo.create({
      workspaceId: "workspace-a",
      agentId: "agent-b",
      name: "other",
      description: "Other agent",
      body: "Other body",
    });

    const source = createD1SkillSource({
      env,
      threadId: "thread-a",
      resolveRuntimeConfig: async () => ({ workspaceId: "workspace-a", agentId: "agent-a" }),
    });

    expect(source.id).toBe("nadi-agent-skills");
    expect(source.fingerprint).toBe("nadi-d1-agent-skills-v1");
    await expect(source.list()).resolves.toMatchObject([
      {
        name: "review",
        description: "Review code",
        sourceId: "nadi-agent-skills",
      },
    ]);
    await expect(source.load("review")).resolves.toMatchObject({
      name: "review",
      description: "Review code",
      body: "Review body",
      resources: [],
    });
    await expect(source.load("archived")).resolves.toBeNull();
    await expect(source.load("other")).resolves.toBeNull();
  });

  it("excludes disabled skills from both list and load", async () => {
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-a",
      agentId: "agent-a",
      threadId: "thread-a",
    });
    const repo = new AgentSkillRepository(drizzle(env.REGISTRY_DB, { schema }));
    const disabled = await repo.create({
      workspaceId: "workspace-a",
      agentId: "agent-a",
      name: "review",
      description: "Review code",
      body: "Review body",
    });
    await repo.setEnabled({
      workspaceId: "workspace-a",
      agentId: "agent-a",
      id: disabled.id,
      enabled: false,
    });

    const source = createD1SkillSource({
      env,
      threadId: "thread-a",
      resolveRuntimeConfig: async () => ({ workspaceId: "workspace-a", agentId: "agent-a" }),
    });

    await expect(source.list()).resolves.toEqual([]);
    // Even if the name is supplied directly, a disabled skill must not load.
    await expect(source.load("review")).resolves.toBeNull();
  });

  it("returns an empty D1 catalog when runtime resolution fails", async () => {
    const source = createD1SkillSource({
      env,
      threadId: "thread-missing",
      resolveRuntimeConfig: async () => {
        throw new Error("thread missing");
      },
    });

    await expect(source.list()).resolves.toEqual([]);
    await expect(source.load("review")).resolves.toBeNull();
  });
});
