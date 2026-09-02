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
  /**
   * A library skill resolves for writes exactly as it resolves for reads.
   *
   * Before this, `edit_skill` was hard-scoped to the thread's agent, so a model
   * could read a library skill and not change it — and its natural recovery,
   * `create_skill` with the same name, SUCCEEDED and forked a private shadow.
   * The fork is the defect; resolving the write the same way the turn resolves
   * the skill is what removes the reason to reach for it.
   */
  it("edits the shared library skill in place, and reports how far the change reaches", async () => {
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-lib",
      agentId: "agent-lib",
      threadId: "thread-lib",
    });
    // A second agent in the same workspace, so the reach count is not 1 by
    // default and a hardcoded number could not pass.
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-lib",
      agentId: "agent-lib-2",
      threadId: "thread-lib-2",
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

    const result = await runTool(tools, "edit_skill", { name: "Deploy", body: "Fixed" });
    expect(result).toContain("edited skill: deploy");
    // The blast radius, in the only surface a chat edit has: the transcript.
    expect(result).toContain("shared workspace-library skill");
    expect(result).toContain("2 agents");

    // The LIBRARY row changed — one copy, so every agent gets the fix.
    await expect(
      repo.getActiveByName({ workspaceId: "workspace-lib", agentId: null, name: "deploy" }),
    ).resolves.toMatchObject({ body: "Fixed", archivedAt: null });
    // ...and no private fork was created on the way.
    await expect(
      repo.getActiveByName({ workspaceId: "workspace-lib", agentId: "agent-lib", name: "deploy" }),
    ).resolves.toBeUndefined();

    // A name in NEITHER scope still gets the plain answer, so the widened
    // resolution cannot swallow a genuine typo.
    await expect(runTool(tools, "edit_skill", { name: "nowhere", body: "x" })).resolves.toBe(
      "error: skill nowhere not found",
    );
  });

  /**
   * The script and the domains have to land in the RESOLVED scope, not the
   * thread's agent scope.
   *
   * A library skill's resources hang off the library row. Both setters look the
   * skill up by name IN THE SCOPE THEY ARE GIVEN and throw when it is not
   * there, so passing the thread's agent id — which is what the old
   * agent-scoped code did — turns a valid edit into
   * `error: skill not found: deploy` AFTER the body has already been written.
   * The skill would read as half-updated, with the caller told it failed.
   */
  it("writes a library skill's script and domains into the library scope", async () => {
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-libres",
      agentId: "agent-libres",
      threadId: "thread-libres",
    });
    const repo = new AgentSkillRepository(drizzle(env.REGISTRY_DB, { schema }));
    const library = await repo.create({
      workspaceId: "workspace-libres",
      agentId: null,
      name: "deploy",
      description: "Deploy",
      body: "Library body",
    });
    const tools = createSkillManagementTools({ env, threadId: "thread-libres" });

    const result = await runTool(tools, "edit_skill", {
      name: "deploy",
      body: "Fixed",
      script: { path: "scripts/run.py", source: "print(2)" },
      networkDomains: ["example.com"],
    });
    expect(result).toContain("edited skill: deploy");

    // The resources hang off the LIBRARY row's id.
    const descriptors = await repo.listResourceDescriptors(library.id);
    expect(descriptors).toContainEqual(expect.objectContaining({ path: "scripts/run.py" }));
    await expect(
      repo.getActiveByName({ workspaceId: "workspace-libres", agentId: null, name: "deploy" }),
    ).resolves.toMatchObject({ networkDomains: JSON.stringify(["example.com"]) });

    // Nothing was created under the agent on the way.
    await expect(
      repo.getActiveByName({
        workspaceId: "workspace-libres",
        agentId: "agent-libres",
        name: "deploy",
      }),
    ).resolves.toBeUndefined();
  });

  /**
   * Reach has to be read BEFORE the archive: `countAgentsLiveOn` skips archived
   * rows, so asking afterwards always answers zero and the transcript would
   * under-report exactly what was just removed from every agent.
   */
  it("deletes the shared library skill, reporting the reach it had before the archive", async () => {
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-libdel",
      agentId: "agent-libdel",
      threadId: "thread-libdel",
    });
    const repo = new AgentSkillRepository(drizzle(env.REGISTRY_DB, { schema }));
    await repo.create({
      workspaceId: "workspace-libdel",
      agentId: null,
      name: "deploy",
      description: "Deploy",
      body: "Library body",
    });
    const tools = createSkillManagementTools({ env, threadId: "thread-libdel" });

    const result = await runTool(tools, "delete_skill", { name: "deploy" });
    expect(result).toContain("deleted skill: deploy");
    expect(result).toContain("shared workspace-library skill");
    expect(result).toContain("1 agent");
    expect(result).not.toContain("no agent has it in scope");

    await expect(
      repo.getActiveByName({ workspaceId: "workspace-libdel", agentId: null, name: "deploy" }),
    ).resolves.toBeUndefined();
  });

  /**
   * An EXCLUDED library skill is not in this agent's effective set, so it does
   * not resolve — and a bare "not found" for a skill the user can see in
   * Settings is a dead end. It gets the scope explained instead, and the same
   * steer away from the fork.
   */
  it("explains the scope for a library skill this agent is excluded from", async () => {
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-excl",
      agentId: "agent-excl",
      threadId: "thread-excl",
    });
    const repo = new AgentSkillRepository(drizzle(env.REGISTRY_DB, { schema }));
    const library = await repo.create({
      workspaceId: "workspace-excl",
      agentId: null,
      name: "deploy",
      description: "Deploy",
      body: "Library body",
    });
    await repo.excludeLibrarySkill({ agentId: "agent-excl", skillId: library.id });
    const tools = createSkillManagementTools({ env, threadId: "thread-excl" });

    for (const result of [
      await runTool(tools, "edit_skill", { name: "deploy", body: "Fixed" }),
      await runTool(tools, "delete_skill", { name: "deploy" }),
    ]) {
      expect(result).toContain("excluded from");
      expect(result).toContain("Do NOT create a skill with the same name");
      expect(result).not.toContain("skill deploy not found");
    }

    // Neither refusal touched the library row.
    await expect(
      repo.getActiveByName({ workspaceId: "workspace-excl", agentId: null, name: "deploy" }),
    ).resolves.toMatchObject({ body: "Library body", archivedAt: null });
  });

  /**
   * Shadowing is the spec's rule and not an error — but it is invisible from
   * chat, and it is what a model reaches for when it means to fix the shared
   * skill. So the result says it happened.
   */
  it("says so when a created skill shadows a library skill of the same name", async () => {
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-shadow",
      agentId: "agent-shadow",
      threadId: "thread-shadow",
    });
    const repo = new AgentSkillRepository(drizzle(env.REGISTRY_DB, { schema }));
    await repo.create({
      workspaceId: "workspace-shadow",
      agentId: null,
      name: "deploy",
      description: "Shared",
      body: "Library body",
    });
    const tools = createSkillManagementTools({ env, threadId: "thread-shadow" });

    const shadowing = await runTool(tools, "create_skill", {
      name: "deploy",
      description: "Private",
      body: "Own body",
    });
    expect(shadowing).toContain("created skill: deploy");
    expect(shadowing).toContain("SHADOWS");
    expect(shadowing).toContain("this agent");

    // A name the library does NOT hold gets the plain answer — the note must
    // not fire on every create.
    await expect(
      runTool(tools, "create_skill", { name: "solo", description: "d", body: "b" }),
    ).resolves.toBe("created skill: solo");
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
