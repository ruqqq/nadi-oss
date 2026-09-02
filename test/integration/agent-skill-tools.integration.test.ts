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

  /**
   * The other door into the library's edit gap. These tools are scoped to the
   * thread's agent, so a shared library skill is invisible to `edit`/`archive`
   * even though the model can READ it (the catalog is `listEffective`). A bare
   * "not found" steers the model into `create_skill` with the same name, which
   * SUCCEEDS and forks a private copy — this agent fixed, every other agent
   * silently stale.
   *
   * These assert the TOOL RESULT, which is what the model is shown: `execute`'s
   * return value is the tool output the SDK feeds back into the turn, not a log
   * line.
   */
  it("redirects a library skill to Settings instead of answering not found", async () => {
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-lib",
      agentId: "agent-lib",
      threadId: "thread-lib",
    });
    const repo = new AgentSkillRepository(drizzle(env.REGISTRY_DB, { schema }));
    await repo.create({
      workspaceId: "workspace-lib",
      agentId: null,
      name: "deploy",
      description: "Deploy",
      body: "Library body",
    });
    const tools = createSkillManagementTools({ env, threadId: "thread-lib" });

    for (const result of [
      await runTool(tools, "edit_skill", { name: "Deploy", body: "Fixed" }),
      await runTool(tools, "delete_skill", { name: "deploy" }),
    ]) {
      expect(result).toContain("shared workspace-library skill");
      expect(result).toContain("Settings -> Skills");
      // The steer away from the fork, which is the whole point of the message.
      expect(result).toContain("Do NOT create a skill with the same name");
      // The old wording is GONE, not merely appended to.
      expect(result).not.toContain("skill deploy not found");
    }

    // The library row is untouched by either refusal.
    await expect(
      repo.getActiveByName({ workspaceId: "workspace-lib", agentId: null, name: "deploy" }),
    ).resolves.toMatchObject({ body: "Library body", archivedAt: null });

    // ...and a name that is in NEITHER scope still gets the plain answer, so the
    // redirect cannot swallow a genuine typo.
    await expect(runTool(tools, "edit_skill", { name: "nowhere", body: "x" })).resolves.toBe(
      "error: skill nowhere not found",
    );
  });

  /**
   * The redirect must not fire for the agent's OWN skill of the same name: that
   * one is editable here, and telling the model to go to Settings would send it
   * to a page that cannot change this agent's private copy.
   */
  it("still edits the agent's own skill when the library has one by the same name", async () => {
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-both",
      agentId: "agent-both",
      threadId: "thread-both",
    });
    const repo = new AgentSkillRepository(drizzle(env.REGISTRY_DB, { schema }));
    await repo.create({
      workspaceId: "workspace-both",
      agentId: null,
      name: "deploy",
      description: "Shared",
      body: "Library body",
    });
    await repo.create({
      workspaceId: "workspace-both",
      agentId: "agent-both",
      name: "deploy",
      description: "Private",
      body: "Own body",
    });
    const tools = createSkillManagementTools({ env, threadId: "thread-both" });

    await expect(runTool(tools, "edit_skill", { name: "deploy", body: "Fixed" })).resolves.toBe(
      "edited skill: deploy",
    );
    await expect(
      repo.getActiveByName({
        workspaceId: "workspace-both",
        agentId: "agent-both",
        name: "deploy",
      }),
    ).resolves.toMatchObject({ body: "Fixed" });
    // The library copy is NOT what was edited.
    await expect(
      repo.getActiveByName({ workspaceId: "workspace-both", agentId: null, name: "deploy" }),
    ).resolves.toMatchObject({ body: "Library body" });
  });

  /**
   * Scope, not just name: another workspace's library skill must read as a plain
   * "not found", or the message leaks that a skill by that name exists
   * elsewhere.
   */
  it("does not redirect for a library skill in another workspace", async () => {
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-mine",
      agentId: "agent-mine",
      threadId: "thread-mine",
    });
    // The other workspace has to exist: `skills.workspace_id` is a FK.
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-theirs",
      agentId: "agent-theirs",
      threadId: "thread-theirs",
    });
    await new AgentSkillRepository(drizzle(env.REGISTRY_DB, { schema })).create({
      workspaceId: "workspace-theirs",
      agentId: null,
      name: "deploy",
      description: "Theirs",
      body: "Theirs",
    });
    const tools = createSkillManagementTools({ env, threadId: "thread-mine" });

    await expect(runTool(tools, "edit_skill", { name: "deploy", body: "x" })).resolves.toBe(
      "error: skill deploy not found",
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
