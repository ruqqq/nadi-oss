import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { AgentSkillRepository } from "../../src/db/repositories/agent-skills";
import * as schema from "../../src/db/schema";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";

const WORKSPACE = "workspace-scopes";
const AGENT = "agent-scopes";
const OTHER_AGENT = "agent-scopes-other";

function repo() {
  return new AgentSkillRepository(drizzle(env.REGISTRY_DB, { schema }));
}

async function seed() {
  await applyRegistryTestSchema(env.REGISTRY_DB);
  const db = drizzle(env.REGISTRY_DB, { schema });
  await db.delete(schema.agentSkillExclusions);
  await db.delete(schema.agentSkillResources);
  await db.delete(schema.skills);
  await seedRegistryThread(env.REGISTRY_DB, {
    workspaceId: WORKSPACE,
    agentId: AGENT,
    threadId: "thread-scopes",
  });
  await seedRegistryThread(env.REGISTRY_DB, {
    workspaceId: WORKSPACE,
    agentId: OTHER_AGENT,
    threadId: "thread-scopes-other",
  });
}

/** Insert straight through drizzle so the DB constraint, not the repo, answers. */
async function insertSkill(input: {
  id: string;
  agentId: string | null;
  name: string;
  networkDomains?: string[];
  enabled?: boolean;
  archivedAt?: number | null;
}) {
  await drizzle(env.REGISTRY_DB, { schema })
    .insert(schema.skills)
    .values({
      id: input.id,
      workspaceId: WORKSPACE,
      agentId: input.agentId,
      name: input.name,
      description: `${input.name} description`,
      body: `${input.name} body`,
      networkDomains: input.networkDomains ? JSON.stringify(input.networkDomains) : null,
      enabled: input.enabled ?? true,
      createdAt: 1,
      updatedAt: 1,
      archivedAt: input.archivedAt ?? null,
    });
}

/**
 * D1 wraps the SQLite error, so the UNIQUE text is on the `cause` chain rather
 * than the thrown message. Assert on the whole chain, or a rejection for some
 * unrelated reason would pass for a constraint doing its job.
 */
async function expectUniqueViolation(promise: Promise<unknown>) {
  let thrown: unknown;
  await promise.then(
    () => {
      throw new Error("expected a UNIQUE constraint violation, but the insert succeeded");
    },
    (error: unknown) => {
      thrown = error;
    },
  );
  const chain: string[] = [];
  for (let current = thrown, depth = 0; current && depth < 5; depth++) {
    chain.push(String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  expect(chain.join("\n")).toMatch(/UNIQUE constraint failed/i);
}

describe("skills have two scopes", () => {
  beforeEach(async () => {
    await seed();
  });

  it("refuses a second library skill with the same name", async () => {
    await insertSkill({ id: "lib-deploy", agentId: null, name: "deploy" });

    // SQLite treats NULLs as DISTINCT in a unique index, so a single
    // (workspace_id, agent_id, name) index would accept this silently and
    // resolution would then pick one of the two arbitrarily.
    await expectUniqueViolation(
      insertSkill({ id: "lib-deploy-dupe", agentId: null, name: "deploy" }),
    );

    const rows = await drizzle(env.REGISTRY_DB, { schema }).select().from(schema.skills).all();
    expect(rows.map((row) => row.id)).toEqual(["lib-deploy"]);
  });

  it("still refuses a second skill with the same name on one agent", async () => {
    await insertSkill({ id: "own-deploy", agentId: AGENT, name: "deploy" });
    await expectUniqueViolation(
      insertSkill({ id: "own-deploy-dupe", agentId: AGENT, name: "deploy" }),
    );
  });

  it("lets an archived library skill share a name with the live one", async () => {
    await insertSkill({ id: "lib-old", agentId: null, name: "deploy", archivedAt: 5 });
    await insertSkill({ id: "lib-new", agentId: null, name: "deploy" });
    const effective = await repo().listEffective({ workspaceId: WORKSPACE, agentId: AGENT });
    expect(effective.map((row) => row.id)).toEqual(["lib-new"]);
  });

  it("lets two different agents each own a skill of the same name", async () => {
    await insertSkill({ id: "a-deploy", agentId: AGENT, name: "deploy" });
    await insertSkill({ id: "b-deploy", agentId: OTHER_AGENT, name: "deploy" });
    await expect(
      repo().listEffective({ workspaceId: WORKSPACE, agentId: AGENT }),
    ).resolves.toMatchObject([{ id: "a-deploy" }]);
    await expect(
      repo().listEffective({ workspaceId: WORKSPACE, agentId: OTHER_AGENT }),
    ).resolves.toMatchObject([{ id: "b-deploy" }]);
  });

  it("puts a library skill on every agent with no rows written anywhere", async () => {
    await insertSkill({ id: "lib-review", agentId: null, name: "review" });

    expect(await repo().listExcludedSkillIds(AGENT)).toEqual([]);
    for (const agentId of [AGENT, OTHER_AGENT]) {
      const effective = await repo().listEffective({ workspaceId: WORKSPACE, agentId });
      expect(effective.map((row) => row.id)).toEqual(["lib-review"]);
    }
  });

  it("drops a library skill from the agent that excluded it, and only that one", async () => {
    await insertSkill({ id: "lib-review", agentId: null, name: "review" });
    await repo().excludeLibrarySkill({ agentId: AGENT, skillId: "lib-review" });

    await expect(repo().listEffective({ workspaceId: WORKSPACE, agentId: AGENT })).resolves.toEqual(
      [],
    );
    await expect(
      repo().listEffective({ workspaceId: WORKSPACE, agentId: OTHER_AGENT }),
    ).resolves.toMatchObject([{ id: "lib-review" }]);
    expect(await repo().listExcludedSkillIds(AGENT)).toEqual(["lib-review"]);

    await repo().includeLibrarySkill({ agentId: AGENT, skillId: "lib-review" });
    await expect(
      repo().listEffective({ workspaceId: WORKSPACE, agentId: AGENT }),
    ).resolves.toMatchObject([{ id: "lib-review" }]);
  });

  it("keeps an agent's own skills alongside the library's", async () => {
    await insertSkill({ id: "lib-review", agentId: null, name: "review" });
    await insertSkill({ id: "own-notes", agentId: AGENT, name: "notes" });

    const effective = await repo().listEffective({ workspaceId: WORKSPACE, agentId: AGENT });
    expect(effective.map((row) => row.id).sort()).toEqual(["lib-review", "own-notes"]);
    // The other agent sees the library one only.
    await expect(
      repo().listEffective({ workspaceId: WORKSPACE, agentId: OTHER_AGENT }),
    ).resolves.toMatchObject([{ id: "lib-review" }]);
  });

  it("shadows a library skill with the agent's own of the same name", async () => {
    await insertSkill({ id: "lib-deploy", agentId: null, name: "deploy" });
    await insertSkill({ id: "own-deploy", agentId: AGENT, name: "deploy" });

    const effective = await repo().listEffective({ workspaceId: WORKSPACE, agentId: AGENT });
    // Exactly one `deploy`, and it is the agent's own: the library one is not
    // loaded at all, so the model never sees two skills with one name.
    expect(effective.map((row) => row.id)).toEqual(["own-deploy"]);
    await expect(
      repo().getEffectiveByName({ workspaceId: WORKSPACE, agentId: AGENT, name: "deploy" }),
    ).resolves.toMatchObject({ id: "own-deploy" });
    // The agent that did not override it still gets the library one.
    await expect(
      repo().getEffectiveByName({ workspaceId: WORKSPACE, agentId: OTHER_AGENT, name: "deploy" }),
    ).resolves.toMatchObject({ id: "lib-deploy" });
  });

  it("resolves an excluded library skill by name to nothing", async () => {
    await insertSkill({ id: "lib-deploy", agentId: null, name: "deploy" });
    await repo().excludeLibrarySkill({ agentId: AGENT, skillId: "lib-deploy" });
    await expect(
      repo().getEffectiveByName({ workspaceId: WORKSPACE, agentId: AGENT, name: "deploy" }),
    ).resolves.toBeUndefined();
  });

  it("hides a disabled library skill but still lets it shadow", async () => {
    await insertSkill({ id: "lib-deploy", agentId: null, name: "deploy" });
    await insertSkill({ id: "own-deploy", agentId: AGENT, name: "deploy", enabled: false });
    // The agent owns the name; a disabled own skill means "off here", not
    // "fall back to the library's".
    await expect(repo().listEffective({ workspaceId: WORKSPACE, agentId: AGENT })).resolves.toEqual(
      [],
    );
  });

  it("opens a library skill's egress hosts only for agents that have it", async () => {
    await insertSkill({
      id: "lib-deploy",
      agentId: null,
      name: "deploy",
      networkDomains: ["library.example.com"],
    });
    await insertSkill({
      id: "own-notes",
      agentId: AGENT,
      name: "notes",
      networkDomains: ["own.example.com"],
    });

    await expect(
      repo().listEnabledSkillDomains({ workspaceId: WORKSPACE, agentId: AGENT }),
    ).resolves.toEqual(expect.arrayContaining(["library.example.com", "own.example.com"]));

    await repo().excludeLibrarySkill({ agentId: AGENT, skillId: "lib-deploy" });

    // If an excluded skill's hosts stayed open, the opt-out would be cosmetic.
    await expect(
      repo().listEnabledSkillDomains({ workspaceId: WORKSPACE, agentId: AGENT }),
    ).resolves.toEqual(["own.example.com"]);
    // ...and the agent that kept it still gets them.
    await expect(
      repo().listEnabledSkillDomains({ workspaceId: WORKSPACE, agentId: OTHER_AGENT }),
    ).resolves.toEqual(["library.example.com"]);
  });

  it("does not open the hosts of a library skill the agent shadows", async () => {
    await insertSkill({
      id: "lib-deploy",
      agentId: null,
      name: "deploy",
      networkDomains: ["library.example.com"],
    });
    await insertSkill({ id: "own-deploy", agentId: AGENT, name: "deploy" });
    await expect(
      repo().listEnabledSkillDomains({ workspaceId: WORKSPACE, agentId: AGENT }),
    ).resolves.toEqual([]);
  });

  it("opens the script gate for a library script, and closes it on exclusion", async () => {
    await insertSkill({ id: "lib-deploy", agentId: null, name: "deploy" });
    await drizzle(env.REGISTRY_DB, { schema }).insert(schema.agentSkillResources).values({
      id: "res-1",
      skillId: "lib-deploy",
      path: "scripts/run.sh",
      kind: "script",
      encoding: "text",
      mimeType: null,
      content: "echo hi",
      createdAt: 1,
      updatedAt: 1,
    });

    await expect(
      repo().hasEnabledScriptSkill({ workspaceId: WORKSPACE, agentId: AGENT }),
    ).resolves.toBe(true);

    await repo().excludeLibrarySkill({ agentId: AGENT, skillId: "lib-deploy" });

    await expect(
      repo().hasEnabledScriptSkill({ workspaceId: WORKSPACE, agentId: AGENT }),
    ).resolves.toBe(false);
    await expect(
      repo().hasEnabledScriptSkill({ workspaceId: WORKSPACE, agentId: OTHER_AGENT }),
    ).resolves.toBe(true);
  });

  it("does not leak a library skill across workspaces", async () => {
    await insertSkill({ id: "lib-review", agentId: null, name: "review" });
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-elsewhere",
      agentId: "agent-elsewhere",
      threadId: "thread-elsewhere",
    });
    await expect(
      repo().listEffective({ workspaceId: "workspace-elsewhere", agentId: "agent-elsewhere" }),
    ).resolves.toEqual([]);
  });
});
