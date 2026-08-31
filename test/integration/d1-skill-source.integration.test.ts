import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AgentSkillRepository } from "../../src/db/repositories/agent-skills";
import { createD1SkillSource } from "../../src/agent/skills/d1-skill-source";
import * as schema from "../../src/db/schema";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";

const scope = { workspaceId: "workspace-a", agentId: "agent-a" };

describe("createD1SkillSource resources", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });
  beforeEach(async () => {
    const db = drizzle(env.REGISTRY_DB, { schema });
    await db.delete(schema.agentSkillResources);
    await db.delete(schema.skills);
    await db.delete(schema.threadIndex);
    await seedRegistryThread(env.REGISTRY_DB, { ...scope, threadId: "thread-a" });
    const repo = new AgentSkillRepository(db);
    await repo.create({ ...scope, name: "greet", description: "greets", body: "instructions" });
    await repo.setScript({
      ...scope,
      name: "greet",
      path: "scripts/run.py",
      source: "print('hi')",
    });
  });

  function source() {
    return createD1SkillSource({
      env,
      threadId: "thread-a",
      resolveRuntimeConfig: async () => scope,
    });
  }

  it("load() returns script resource descriptors without content", async () => {
    const content = await source().load("greet");
    expect(
      content?.resources?.some((r) => r.path === "scripts/run.py" && r.kind === "script"),
    ).toBe(true);
    expect((content?.resources?.[0] as { content?: string }).content).toBeUndefined();
  });

  it("readResource() returns content, scoped and enabled-gated", async () => {
    expect((await source().readResource!("greet", "scripts/run.py"))?.content).toBe("print('hi')");
    const db = drizzle(env.REGISTRY_DB, { schema });
    const row = await new AgentSkillRepository(db).getActiveByName({ ...scope, name: "greet" });
    await new AgentSkillRepository(db).setEnabled({ ...scope, id: row!.id, enabled: false });
    expect(await source().readResource!("greet", "scripts/run.py")).toBeNull();
    expect(await source().load("greet")).toBeNull();
  });
});
