import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AgentSkillDuplicateError,
  AgentSkillRepository,
} from "../../src/db/repositories/agent-skills";
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

/** An extra agent in the same workspace. `seed()` already made AGENT and OTHER_AGENT. */
async function insertAgent(input: { id: string; enabled?: boolean; archivedAt?: number | null }) {
  await drizzle(env.REGISTRY_DB, { schema })
    .insert(schema.agents)
    .values({
      id: input.id,
      workspaceId: WORKSPACE,
      name: input.id,
      systemPrompt: "You are Nadi.",
      provider: "mock",
      model: "mock",
      enabled: input.enabled ?? true,
      archivedAt: input.archivedAt ?? null,
      createdAt: 1,
    });
}

async function insertResource(input: {
  id: string;
  skillId: string;
  path: string;
  content: string;
}) {
  await drizzle(env.REGISTRY_DB, { schema }).insert(schema.agentSkillResources).values({
    id: input.id,
    skillId: input.skillId,
    path: input.path,
    kind: "script",
    encoding: "text",
    mimeType: null,
    content: input.content,
    createdAt: 1,
    updatedAt: 1,
  });
}

async function resourcesOf(skillId: string) {
  return drizzle(env.REGISTRY_DB, { schema })
    .select()
    .from(schema.agentSkillResources)
    .where(eq(schema.agentSkillResources.skillId, skillId))
    .all();
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

  it("annotates a library skill excluded for this agent", async () => {
    await insertSkill({ id: "lib-deploy", agentId: null, name: "deploy" });
    await repo().excludeLibrarySkill({ agentId: AGENT, skillId: "lib-deploy" });

    const forA = await repo().listLibraryForAgent({ workspaceId: WORKSPACE, agentId: AGENT });
    const forB = await repo().listLibraryForAgent({ workspaceId: WORKSPACE, agentId: OTHER_AGENT });

    // The excluded skill is still LISTED — the UI needs something to toggle
    // back on, which `listEffective` (from which it has vanished) cannot give.
    expect(forA.map((s) => [s.name, s.excluded])).toEqual([["deploy", true]]);
    expect(forB.map((s) => [s.name, s.excluded])).toEqual([["deploy", false]]);
    expect(forA[0]?.shadowedByOwnSkillId).toBeNull();
  });

  it("marks a library skill shadowed by the agent's own skill of the same name", async () => {
    await insertSkill({ id: "lib-deploy", agentId: null, name: "deploy" });
    await insertSkill({ id: "own-deploy", agentId: AGENT, name: "deploy" });

    const [row] = await repo().listLibraryForAgent({ workspaceId: WORKSPACE, agentId: AGENT });
    expect(row?.shadowedByOwnSkillId).toBe("own-deploy");
    // Shadowing is not exclusion — they are different states, and the UI has to
    // say which one is why the library row is not live here.
    expect(row?.excluded).toBe(false);

    const [other] = await repo().listLibraryForAgent({
      workspaceId: WORKSPACE,
      agentId: OTHER_AGENT,
    });
    expect(other?.shadowedByOwnSkillId).toBeNull();
  });

  it("still marks shadowed when the agent's own skill is disabled", async () => {
    await insertSkill({ id: "lib-deploy", agentId: null, name: "deploy" });
    await insertSkill({ id: "own-deploy", agentId: AGENT, name: "deploy", enabled: false });

    // `listEffective` drops the library row for a DISABLED own skill too (the
    // agent owns the name). If the shadow join filtered on `enabled` the UI
    // would show the library skill as live while the model never loads it.
    await expect(repo().listEffective({ workspaceId: WORKSPACE, agentId: AGENT })).resolves.toEqual(
      [],
    );
    const [row] = await repo().listLibraryForAgent({ workspaceId: WORKSPACE, agentId: AGENT });
    expect(row?.shadowedByOwnSkillId).toBe("own-deploy");
  });

  it("does not treat an archived own skill as shadowing", async () => {
    await insertSkill({ id: "lib-deploy", agentId: null, name: "deploy" });
    await insertSkill({ id: "own-deploy", agentId: AGENT, name: "deploy", archivedAt: 7 });

    const [row] = await repo().listLibraryForAgent({ workspaceId: WORKSPACE, agentId: AGENT });
    expect(row?.shadowedByOwnSkillId).toBeNull();
    await expect(
      repo().listEffective({ workspaceId: WORKSPACE, agentId: AGENT }),
    ).resolves.toMatchObject([{ id: "lib-deploy" }]);
  });

  it("lists only the workspace library: not the agent's own, not archived, not another workspace's", async () => {
    await insertSkill({ id: "lib-review", agentId: null, name: "review" });
    await insertSkill({ id: "lib-gone", agentId: null, name: "gone", archivedAt: 9 });
    await insertSkill({ id: "own-notes", agentId: AGENT, name: "notes" });
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-elsewhere",
      agentId: "agent-elsewhere",
      threadId: "thread-elsewhere-lib",
    });
    await drizzle(env.REGISTRY_DB, { schema }).insert(schema.skills).values({
      id: "elsewhere-review",
      workspaceId: "workspace-elsewhere",
      agentId: null,
      name: "review",
      description: "d",
      body: "b",
      networkDomains: null,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
      archivedAt: null,
    });

    const rows = await repo().listLibraryForAgent({ workspaceId: WORKSPACE, agentId: AGENT });
    expect(rows.map((s) => s.id)).toEqual(["lib-review"]);
  });

  it("lists a DISABLED library skill, so the agent view can say why it is off", async () => {
    await insertSkill({ id: "lib-off", agentId: null, name: "off", enabled: false });
    const rows = await repo().listLibraryForAgent({ workspaceId: WORKSPACE, agentId: AGENT });
    expect(rows).toMatchObject([{ id: "lib-off", enabled: false, excluded: false }]);
  });

  it("returns one row per library skill even with an exclusion and a shadow both present", async () => {
    await insertSkill({ id: "lib-deploy", agentId: null, name: "deploy" });
    await insertSkill({ id: "own-deploy", agentId: AGENT, name: "deploy" });
    await repo().excludeLibrarySkill({ agentId: AGENT, skillId: "lib-deploy" });

    const rows = await repo().listLibraryForAgent({ workspaceId: WORKSPACE, agentId: AGENT });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "lib-deploy",
      excluded: true,
      shadowedByOwnSkillId: "own-deploy",
    });
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

  it("counts agents the library skill is live on, excluding opt-outs and shadows", async () => {
    await insertSkill({ id: "lib-deploy", agentId: null, name: "deploy" });
    // AGENT: plain. OTHER_AGENT: excluded. agent-shadow: owns the name.
    // agent-paused: disabled but still carries it. agent-gone: archived.
    await insertAgent({ id: "agent-shadow" });
    await insertAgent({ id: "agent-paused", enabled: false });
    await insertAgent({ id: "agent-gone", archivedAt: 5 });
    await repo().excludeLibrarySkill({ agentId: OTHER_AGENT, skillId: "lib-deploy" });
    await insertSkill({ id: "shadow-deploy", agentId: "agent-shadow", name: "deploy" });

    const counts = await repo().countAgentsLiveOn(["lib-deploy"]);
    // AGENT + agent-paused. A paused agent still carries the skill and recovers
    // on re-enable; dropping it would understate the blast radius of an edit.
    expect(counts.get("lib-deploy")).toBe(2);

    // The count has to agree with what resolution actually loads, agent by agent.
    const live: string[] = [];
    for (const agentId of [AGENT, OTHER_AGENT, "agent-shadow", "agent-paused"]) {
      const effective = await repo().listEffective({ workspaceId: WORKSPACE, agentId });
      if (effective.some((row) => row.id === "lib-deploy")) live.push(agentId);
    }
    expect(live).toEqual([AGENT, "agent-paused"]);
  });

  it("answers for a batch of ids in one map, zero included", async () => {
    await insertSkill({ id: "lib-a", agentId: null, name: "alpha" });
    await insertSkill({ id: "lib-b", agentId: null, name: "beta" });
    await repo().excludeLibrarySkill({ agentId: AGENT, skillId: "lib-b" });
    await repo().excludeLibrarySkill({ agentId: OTHER_AGENT, skillId: "lib-b" });

    const counts = await repo().countAgentsLiveOn(["lib-a", "lib-b", "lib-missing"]);
    // Every requested id gets an entry: a caller reading `.get(id)` must not
    // have to tell "nobody" apart from "I forgot to ask".
    expect([...counts.entries()].sort()).toEqual([
      ["lib-a", 2],
      ["lib-b", 0],
      ["lib-missing", 0],
    ]);
  });

  it("returns an empty map for no ids without touching the database", async () => {
    await expect(repo().countAgentsLiveOn([])).resolves.toEqual(new Map());
  });

  it("counts the carriers of a DISABLED library skill", async () => {
    await insertSkill({ id: "lib-off", agentId: null, name: "off", enabled: false });
    // Deliberate divergence from `listEffective`, which returns nothing for a
    // disabled skill: the count answers "who does an edit to this reach", and a
    // workspace-disabled skill reaches both agents the moment it is switched
    // back on. The row carries `enabled: false` for the view to say so.
    expect((await repo().countAgentsLiveOn(["lib-off"])).get("lib-off")).toBe(2);
    await expect(repo().listEffective({ workspaceId: WORKSPACE, agentId: AGENT })).resolves.toEqual(
      [],
    );
  });

  it("counts nobody for an archived or agent-private skill", async () => {
    await insertSkill({ id: "lib-gone", agentId: null, name: "gone", archivedAt: 9 });
    await insertSkill({ id: "own-notes", agentId: AGENT, name: "notes" });
    const counts = await repo().countAgentsLiveOn(["lib-gone", "own-notes"]);
    expect([...counts.values()]).toEqual([0, 0]);
  });

  it("does not count agents from another workspace", async () => {
    await insertSkill({ id: "lib-deploy", agentId: null, name: "deploy" });
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-elsewhere",
      agentId: "agent-elsewhere",
      threadId: "thread-elsewhere-count",
    });
    expect((await repo().countAgentsLiveOn(["lib-deploy"])).get("lib-deploy")).toBe(2);
  });

  it("moving to the library carries the skill's id, script resource and network domains", async () => {
    await insertSkill({
      id: "own-deploy",
      agentId: AGENT,
      name: "deploy",
      networkDomains: ["deploy.example.com"],
    });
    await insertResource({
      id: "res-own",
      skillId: "own-deploy",
      path: "scripts/run.sh",
      content: "echo hi",
    });

    const moved = await repo().moveToLibrary({
      workspaceId: WORKSPACE,
      agentId: AGENT,
      id: "own-deploy",
    });

    // The SAME row travels: promoting must not mean retyping it, and a
    // delete+insert would strand every resource on the old id.
    expect(moved).toMatchObject({ id: "own-deploy", agentId: null, name: "deploy" });
    expect(moved?.networkDomains).toBe(JSON.stringify(["deploy.example.com"]));
    expect((await resourcesOf("own-deploy")).map((r) => r.path)).toEqual(["scripts/run.sh"]);
    // ...and it now reaches the agent that never had it.
    await expect(
      repo().listEffective({ workspaceId: WORKSPACE, agentId: OTHER_AGENT }),
    ).resolves.toMatchObject([{ id: "own-deploy" }]);
  });

  it("refuses a move when an active library skill already has that name", async () => {
    await insertSkill({ id: "lib-deploy", agentId: null, name: "deploy" });
    await insertSkill({ id: "own-deploy", agentId: AGENT, name: "deploy" });
    await expect(
      repo().moveToLibrary({ workspaceId: WORKSPACE, agentId: AGENT, id: "own-deploy" }),
    ).rejects.toBeInstanceOf(AgentSkillDuplicateError);
    // The source is untouched — a refused move must not half-apply.
    const rows = await drizzle(env.REGISTRY_DB, { schema }).select().from(schema.skills).all();
    expect(rows.find((r) => r.id === "own-deploy")?.agentId).toBe(AGENT);
  });

  it("moving to the library does not silently un-shadow: agents with their own copy keep theirs", async () => {
    await insertSkill({ id: "own-deploy", agentId: AGENT, name: "deploy" });
    await insertSkill({ id: "other-deploy", agentId: OTHER_AGENT, name: "deploy" });

    await repo().moveToLibrary({ workspaceId: WORKSPACE, agentId: AGENT, id: "own-deploy" });

    // OTHER_AGENT owns the name `deploy`; the newly-shared skill must not
    // displace its copy, and the model must still see exactly one `deploy`.
    await expect(
      repo().listEffective({ workspaceId: WORKSPACE, agentId: OTHER_AGENT }),
    ).resolves.toMatchObject([{ id: "other-deploy" }]);
    const [row] = await repo().listLibraryForAgent({
      workspaceId: WORKSPACE,
      agentId: OTHER_AGENT,
    });
    expect(row?.shadowedByOwnSkillId).toBe("other-deploy");
    // ...so the promoted skill is live on ONE agent, not two.
    expect((await repo().countAgentsLiveOn(["own-deploy"])).get("own-deploy")).toBe(1);
  });

  it("refuses to move an archived skill, another agent's, or another workspace's", async () => {
    await insertSkill({ id: "own-gone", agentId: AGENT, name: "gone", archivedAt: 4 });
    await insertSkill({ id: "own-notes", agentId: AGENT, name: "notes" });
    await expect(
      repo().moveToLibrary({ workspaceId: WORKSPACE, agentId: AGENT, id: "own-gone" }),
    ).resolves.toBeUndefined();
    await expect(
      repo().moveToLibrary({ workspaceId: WORKSPACE, agentId: OTHER_AGENT, id: "own-notes" }),
    ).resolves.toBeUndefined();
    await expect(
      repo().moveToLibrary({ workspaceId: "workspace-elsewhere", agentId: AGENT, id: "own-notes" }),
    ).resolves.toBeUndefined();
    const rows = await drizzle(env.REGISTRY_DB, { schema }).select().from(schema.skills).all();
    expect(rows.find((r) => r.id === "own-notes")?.agentId).toBe(AGENT);
  });

  it("copying to an agent creates NEW resource rows, not shared ones", async () => {
    await insertSkill({
      id: "lib-deploy",
      agentId: null,
      name: "deploy",
      networkDomains: ["deploy.example.com"],
    });
    await insertResource({
      id: "res-lib",
      skillId: "lib-deploy",
      path: "scripts/run.sh",
      content: "echo original",
    });

    const copy = await repo().copyToAgent({
      workspaceId: WORKSPACE,
      agentId: null,
      id: "lib-deploy",
      targetAgentId: AGENT,
    });

    expect(copy?.id).not.toBe("lib-deploy");
    expect(copy).toMatchObject({ agentId: AGENT, name: "deploy" });
    expect(copy?.networkDomains).toBe(JSON.stringify(["deploy.example.com"]));

    const copied = await resourcesOf(copy?.id ?? "");
    expect(copied.map((r) => [r.path, r.content])).toEqual([["scripts/run.sh", "echo original"]]);
    expect(copied[0]?.id).not.toBe("res-lib");

    // Editing the copy's script must not edit the original's.
    await repo().setScript({
      workspaceId: WORKSPACE,
      agentId: AGENT,
      name: "deploy",
      path: "scripts/run.sh",
      source: "echo edited",
    });
    expect((await resourcesOf(copy?.id ?? "")).map((r) => r.content)).toEqual(["echo edited"]);
    expect((await resourcesOf("lib-deploy")).map((r) => r.content)).toEqual(["echo original"]);
  });

  it("refuses a copy when that agent already has an active skill of that name", async () => {
    await insertSkill({ id: "lib-deploy", agentId: null, name: "deploy" });
    await insertSkill({ id: "own-deploy", agentId: AGENT, name: "deploy" });
    await expect(
      repo().copyToAgent({
        workspaceId: WORKSPACE,
        agentId: null,
        id: "lib-deploy",
        targetAgentId: AGENT,
      }),
    ).rejects.toBeInstanceOf(AgentSkillDuplicateError);
    // Nothing was inserted on the failed path.
    const rows = await drizzle(env.REGISTRY_DB, { schema }).select().from(schema.skills).all();
    expect(rows.map((r) => r.id).sort()).toEqual(["lib-deploy", "own-deploy"]);
  });

  it("leaves the source in the library when it is copied to an agent", async () => {
    await insertSkill({ id: "lib-deploy", agentId: null, name: "deploy" });
    await repo().copyToAgent({
      workspaceId: WORKSPACE,
      agentId: null,
      id: "lib-deploy",
      targetAgentId: AGENT,
    });
    const rows = await drizzle(env.REGISTRY_DB, { schema }).select().from(schema.skills).all();
    expect(rows.find((r) => r.id === "lib-deploy")?.agentId).toBeNull();
    // The copy shadows the library row here, so the model still sees one
    // `deploy` — and the library skill is now live on one fewer agent.
    await expect(
      repo().listEffective({ workspaceId: WORKSPACE, agentId: AGENT }),
    ).resolves.toHaveLength(1);
    expect((await repo().countAgentsLiveOn(["lib-deploy"])).get("lib-deploy")).toBe(1);
  });

  it("refuses to copy an archived skill or one from another workspace", async () => {
    await insertSkill({ id: "lib-gone", agentId: null, name: "gone", archivedAt: 3 });
    await insertSkill({ id: "lib-live", agentId: null, name: "live" });
    await expect(
      repo().copyToAgent({
        workspaceId: WORKSPACE,
        agentId: null,
        id: "lib-gone",
        targetAgentId: AGENT,
      }),
    ).resolves.toBeUndefined();
    await expect(
      repo().copyToAgent({
        workspaceId: "workspace-elsewhere",
        agentId: null,
        id: "lib-live",
        targetAgentId: AGENT,
      }),
    ).resolves.toBeUndefined();
  });
});
