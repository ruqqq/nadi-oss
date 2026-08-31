import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSkillManagementTools } from "../../src/agent/skill-management-tools";
import { AgentSkillRepository } from "../../src/db/repositories/agent-skills";
import * as schema from "../../src/db/schema";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";

type SkillTools = ReturnType<typeof createSkillManagementTools>;

async function runTool<TInput>(tools: SkillTools, name: keyof SkillTools, input: TInput) {
  const tool = tools[name]!;
  return (tool.execute as (i: TInput, o: unknown) => Promise<string>)(input, {});
}

describe("skill management tools", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  beforeEach(async () => {
    const db = drizzle(env.REGISTRY_DB, { schema });
    await db.delete(schema.agentSkillResources);
    await db.delete(schema.skills);
    await db.delete(schema.threadIndex);
  });

  it("creates, edits, and deletes skills for the current thread agent", async () => {
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-a",
      agentId: "agent-a",
      threadId: "thread-a",
    });
    const tools = createSkillManagementTools({ env, threadId: "thread-a" });
    const repo = new AgentSkillRepository(drizzle(env.REGISTRY_DB, { schema }));

    await expect(
      runTool(tools, "create_skill", {
        name: "Code Review",
        description: "Review code",
        body: "Review body",
      }),
    ).resolves.toBe("created skill: code-review");
    await expect(
      repo.getActiveByName({
        workspaceId: "workspace-a",
        agentId: "agent-a",
        name: "code-review",
      }),
    ).resolves.toMatchObject({ description: "Review code", body: "Review body" });

    await expect(
      runTool(tools, "edit_skill", {
        name: "code-review",
        newName: "review",
        description: "Updated",
      }),
    ).resolves.toBe("edited skill: review");
    await expect(
      repo.getActiveByName({ workspaceId: "workspace-a", agentId: "agent-a", name: "review" }),
    ).resolves.toMatchObject({ description: "Updated", body: "Review body" });

    await expect(runTool(tools, "delete_skill", { name: "review" })).resolves.toBe(
      "deleted skill: review",
    );
    await expect(
      repo.listActive({ workspaceId: "workspace-a", agentId: "agent-a" }),
    ).resolves.toEqual([]);
  });

  it("does not leak mutations across agents or workspaces", async () => {
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
    await runTool(createSkillManagementTools({ env, threadId: "thread-a" }), "create_skill", {
      name: "review",
      description: "A",
      body: "A body",
    });
    await runTool(createSkillManagementTools({ env, threadId: "thread-b" }), "create_skill", {
      name: "review",
      description: "B",
      body: "B body",
    });
    await runTool(createSkillManagementTools({ env, threadId: "thread-c" }), "create_skill", {
      name: "review",
      description: "C",
      body: "C body",
    });

    await expect(
      repo.listActive({ workspaceId: "workspace-a", agentId: "agent-a" }),
    ).resolves.toMatchObject([{ body: "A body" }]);
    await expect(
      repo.listActive({ workspaceId: "workspace-a", agentId: "agent-b" }),
    ).resolves.toMatchObject([{ body: "B body" }]);
    await expect(
      repo.listActive({ workspaceId: "workspace-b", agentId: "agent-a" }),
    ).resolves.toMatchObject([{ body: "C body" }]);
  });

  it("returns explicit errors for missing threads, invalid names, duplicates, and missing skills", async () => {
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-a",
      agentId: "agent-a",
      threadId: "thread-a",
    });
    const tools = createSkillManagementTools({ env, threadId: "thread-a" });

    await expect(
      runTool(createSkillManagementTools({ env, threadId: "missing-thread" }), "create_skill", {
        name: "review",
        description: "Review",
        body: "Review body",
      }),
    ).resolves.toBe("error: thread missing-thread not found");
    await expect(
      runTool(tools, "create_skill", {
        name: "../bad",
        description: "Invalid",
        body: "Invalid",
      }),
    ).resolves.toBe("error: invalid skill name");
    await runTool(tools, "create_skill", {
      name: "review",
      description: "Review",
      body: "Review body",
    });
    await expect(
      runTool(tools, "create_skill", {
        name: "Review",
        description: "Duplicate",
        body: "Duplicate body",
      }),
    ).resolves.toBe("error: duplicate skill name: review");
    await expect(runTool(tools, "edit_skill", { name: "missing", body: "Nope" })).resolves.toBe(
      "error: skill missing not found",
    );
    await expect(runTool(tools, "delete_skill", { name: "missing" })).resolves.toBe(
      "error: skill missing not found",
    );
  });

  it("create_skill attaches a script and declares network domains", async () => {
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-a",
      agentId: "agent-a",
      threadId: "thread-a",
    });
    const tools = createSkillManagementTools({ env, threadId: "thread-a" });
    const repo = new AgentSkillRepository(drizzle(env.REGISTRY_DB, { schema }));

    await expect(
      runTool(tools, "create_skill", {
        name: "fetcher",
        description: "Fetch things",
        body: "Fetch body",
        script: { path: "scripts/run.py", source: "print('hi')" },
        networkDomains: ["api.example.com"],
      }),
    ).resolves.toBe("created skill: fetcher");

    const skill = await repo.getActiveByName({
      workspaceId: "workspace-a",
      agentId: "agent-a",
      name: "fetcher",
    });
    expect((await repo.getResource(skill!.id, "scripts/run.py"))?.content).toBe("print('hi')");
    expect(
      await repo.listEnabledSkillDomains({ workspaceId: "workspace-a", agentId: "agent-a" }),
    ).toContain("api.example.com");
  });
});
