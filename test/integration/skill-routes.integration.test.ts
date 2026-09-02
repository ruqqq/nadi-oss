import { SELF, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../src/db/schema";
import { AgentSkillRepository } from "../../src/db/repositories/agent-skills";
import { applyRegistryTestSchema } from "./helpers/registry";

const now = 1_800_000_000_000;

async function seedMemberWithAgent() {
  const db = drizzle(env.REGISTRY_DB, { schema });
  const userId = "user-1";
  const token = "live-token";
  const workspaceId = "ws-1";
  const agentId = "agent-1";
  await db.insert(schema.users).values({
    id: userId,
    email: `${userId}@example.com`,
    name: null,
    createdAt: new Date(now),
    emailVerified: true,
    image: null,
    updatedAt: new Date(now),
  });
  await db.insert(schema.sessions).values({
    id: `sess-${userId}`,
    userId,
    token,
    expiresAt: new Date(now + 60_000),
    createdAt: new Date(now),
    updatedAt: new Date(now),
    ipAddress: null,
    userAgent: null,
  });
  await db.insert(schema.workspaces).values({ id: workspaceId, name: workspaceId, createdAt: now });
  await db
    .insert(schema.workspaceMembers)
    .values({ workspaceId, userId, role: "owner", createdAt: now });
  await db.insert(schema.agents).values({
    id: agentId,
    workspaceId,
    name: "Default",
    systemPrompt: "You are Nadi.",
    provider: "mock",
    model: "mock",
    createdAt: now,
  });
  return { token, workspaceId, agentId };
}

async function seedAgent(workspaceId: string, agentId: string) {
  await drizzle(env.REGISTRY_DB, { schema }).insert(schema.agents).values({
    id: agentId,
    workspaceId,
    name: agentId,
    systemPrompt: "You are Nadi.",
    provider: "mock",
    model: "mock",
    createdAt: now,
  });
  return agentId;
}

/** A second workspace with its own owner, member of nothing else. */
async function seedOtherWorkspace() {
  const db = drizzle(env.REGISTRY_DB, { schema });
  const userId = "user-2";
  const token = "other-token";
  const workspaceId = "ws-2";
  const agentId = "agent-2";
  await db.insert(schema.users).values({
    id: userId,
    email: `${userId}@example.com`,
    name: null,
    createdAt: new Date(now),
    emailVerified: true,
    image: null,
    updatedAt: new Date(now),
  });
  await db.insert(schema.sessions).values({
    id: `sess-${userId}`,
    userId,
    token,
    expiresAt: new Date(now + 60_000),
    createdAt: new Date(now),
    updatedAt: new Date(now),
    ipAddress: null,
    userAgent: null,
  });
  await db.insert(schema.workspaces).values({ id: workspaceId, name: workspaceId, createdAt: now });
  await db
    .insert(schema.workspaceMembers)
    .values({ workspaceId, userId, role: "owner", createdAt: now });
  await seedAgent(workspaceId, agentId);
  return { token, workspaceId, agentId };
}

const cookie = (token: string) => ({ cookie: `better-auth.session_token=${token}` });

describe("skill routes", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });
  beforeEach(async () => {
    const db = drizzle(env.REGISTRY_DB, { schema });
    // Before `agents`: the exclusion rows reference both, and only the skill
    // side cascades.
    await db.delete(schema.agentSkillExclusions);
    await db.delete(schema.skills);
    await db.delete(schema.workspaceMembers);
    await db.delete(schema.agents);
    await db.delete(schema.workspaces);
    await db.delete(schema.sessions);
    await db.delete(schema.users);
  });

  it("401 without a session", async () => {
    const res = await SELF.fetch("https://nadi.test/api/skills");
    expect(res.status).toBe(401);
  });

  // The bare route is the workspace LIBRARY (agent_id IS NULL) — what the
  // Skills settings tab manages. It used to resolve to "the workspace's
  // earliest agent", which after the library promotion showed an almost empty
  // list under a tab labelled as the workspace's skills.
  it("lists the workspace library, not one agent's private skills", async () => {
    const { token, workspaceId, agentId } = await seedMemberWithAgent();
    const repo = new AgentSkillRepository(drizzle(env.REGISTRY_DB, { schema }));
    const library = await repo.create({
      workspaceId,
      agentId: null,
      name: "review",
      description: "Review",
      body: "Body",
    });
    const private_ = await repo.create({
      workspaceId,
      agentId,
      name: "deploy",
      description: "Deploy",
      body: "Body",
    });

    const listed = await SELF.fetch("https://nadi.test/api/skills", { headers: cookie(token) });
    expect(listed.status).toBe(200);
    const { skills } = (await listed.json()) as { skills: Array<{ id: string; enabled: boolean }> };
    expect(skills).toMatchObject([{ id: library.id, enabled: true }]);

    const scoped = await SELF.fetch(`https://nadi.test/api/skills?agentId=${agentId}`, {
      headers: cookie(token),
    });
    const scopedBody = (await scoped.json()) as { skills: Array<{ id: string }> };
    expect(scopedBody.skills.map((skill) => skill.id)).toEqual([private_.id]);
  });

  it("toggles a library skill's enabled flag", async () => {
    const { token, workspaceId } = await seedMemberWithAgent();
    const repo = new AgentSkillRepository(drizzle(env.REGISTRY_DB, { schema }));
    const created = await repo.create({
      workspaceId,
      agentId: null,
      name: "review",
      description: "Review",
      body: "Body",
    });

    const toggled = await SELF.fetch(`https://nadi.test/api/skills/${created.id}/enabled`, {
      method: "POST",
      headers: { ...cookie(token), "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(toggled.status).toBe(200);
    expect(((await toggled.json()) as { skill: { enabled: boolean } }).skill.enabled).toBe(false);
  });

  // An agent's own page archives its private skills through the same route,
  // named by `?agentId=`. Without the parameter the route is looking in the
  // library, where this skill is not.
  it("archives an agent's private skill only when scoped to that agent", async () => {
    const { token, workspaceId, agentId } = await seedMemberWithAgent();
    const repo = new AgentSkillRepository(drizzle(env.REGISTRY_DB, { schema }));
    const created = await repo.create({
      workspaceId,
      agentId,
      name: "deploy",
      description: "Deploy",
      body: "Body",
    });

    const unscoped = await SELF.fetch(`https://nadi.test/api/skills/${created.id}/archive`, {
      method: "POST",
      headers: cookie(token),
    });
    expect(unscoped.status).toBe(404);

    const scoped = await SELF.fetch(
      `https://nadi.test/api/skills/${created.id}/archive?agentId=${agentId}`,
      { method: "POST", headers: cookie(token) },
    );
    expect(scoped.status).toBe(200);
  });

  it("archives, lists archived, and restores", async () => {
    const { token, workspaceId } = await seedMemberWithAgent();
    const repo = new AgentSkillRepository(drizzle(env.REGISTRY_DB, { schema }));
    const created = await repo.create({
      workspaceId,
      agentId: null,
      name: "deploy",
      description: "Deploy",
      body: "Body",
    });

    const archived = await SELF.fetch(`https://nadi.test/api/skills/${created.id}/archive`, {
      method: "POST",
      headers: cookie(token),
    });
    expect(archived.status).toBe(200);

    const archivedList = await SELF.fetch("https://nadi.test/api/skills?archived=1", {
      headers: cookie(token),
    });
    const { skills } = (await archivedList.json()) as { skills: Array<{ id: string }> };
    expect(skills.map((s) => s.id)).toEqual([created.id]);

    const restored = await SELF.fetch(`https://nadi.test/api/skills/${created.id}/restore`, {
      method: "POST",
      headers: cookie(token),
    });
    expect(restored.status).toBe(200);
  });

  it("404 for a skill in another workspace", async () => {
    const { token } = await seedMemberWithAgent();
    const res = await SELF.fetch("https://nadi.test/api/skills/does-not-exist/archive", {
      method: "POST",
      headers: cookie(token),
    });
    expect(res.status).toBe(404);
  });

  // GET /api/agents/:agentId/skills

  it("401 without a session on the agent skills route", async () => {
    const res = await SELF.fetch("https://nadi.test/api/agents/agent-1/skills");
    expect(res.status).toBe(401);
  });

  it("lists the whole library annotated for the agent, plus the agent's own", async () => {
    const { token, workspaceId, agentId } = await seedMemberWithAgent();
    const other = await seedAgent(workspaceId, "agent-1b");
    const repo = new AgentSkillRepository(drizzle(env.REGISTRY_DB, { schema }));
    const kept = await repo.create({
      workspaceId,
      agentId: null,
      name: "review",
      description: "Review",
      body: "Body",
    });
    const dropped = await repo.create({
      workspaceId,
      agentId: null,
      name: "deploy",
      description: "Deploy",
      body: "Body",
    });
    const shadowed = await repo.create({
      workspaceId,
      agentId: null,
      name: "notes",
      description: "Notes",
      body: "Body",
    });
    const own = await repo.create({
      workspaceId,
      agentId,
      name: "notes",
      description: "Own notes",
      body: "Body",
    });
    await repo.excludeLibrarySkill({ agentId, skillId: dropped.id });

    const res = await SELF.fetch(`https://nadi.test/api/agents/${agentId}/skills`, {
      headers: cookie(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      library: Array<{ id: string; excluded: boolean; shadowedByOwnSkillId: string | null }>;
      own: Array<{ id: string }>;
    };
    // Sorted by name: deploy, notes, review.
    expect(body.library).toMatchObject([
      { id: dropped.id, excluded: true, shadowedByOwnSkillId: null },
      { id: shadowed.id, excluded: false, shadowedByOwnSkillId: own.id },
      { id: kept.id, excluded: false, shadowedByOwnSkillId: null },
    ]);
    expect(body.own.map((s) => s.id)).toEqual([own.id]);

    // The sibling agent shares the library and sees none of the annotations.
    const forOther = await SELF.fetch(`https://nadi.test/api/agents/${other}/skills`, {
      headers: cookie(token),
    });
    const otherBody = (await forOther.json()) as {
      library: Array<{ id: string; excluded: boolean; shadowedByOwnSkillId: string | null }>;
      own: unknown[];
    };
    expect(otherBody.library.every((s) => !s.excluded && s.shadowedByOwnSkillId === null)).toBe(
      true,
    );
    expect(otherBody.own).toEqual([]);
  });

  it("404 listing skills for an agent the session does not own", async () => {
    const { token } = await seedMemberWithAgent();
    const foreign = await seedOtherWorkspace();
    const res = await SELF.fetch(`https://nadi.test/api/agents/${foreign.agentId}/skills`, {
      headers: cookie(token),
    });
    expect(res.status).toBe(404);
  });

  // POST /api/agents/:agentId/skills/:skillId/exclusion

  it("excludes and re-includes a library skill for one agent", async () => {
    const { token, workspaceId, agentId } = await seedMemberWithAgent();
    const other = await seedAgent(workspaceId, "agent-1b");
    const repo = new AgentSkillRepository(drizzle(env.REGISTRY_DB, { schema }));
    const lib = await repo.create({
      workspaceId,
      agentId: null,
      name: "review",
      description: "Review",
      body: "Body",
    });

    const excluded = await SELF.fetch(
      `https://nadi.test/api/agents/${agentId}/skills/${lib.id}/exclusion`,
      {
        method: "POST",
        headers: { ...cookie(token), "Content-Type": "application/json" },
        body: JSON.stringify({ excluded: true }),
      },
    );
    expect(excluded.status).toBe(204);
    expect(await repo.listExcludedSkillIds(agentId)).toEqual([lib.id]);
    // The turn-time resolution is what the toggle is really for.
    await expect(repo.listEffective({ workspaceId, agentId })).resolves.toEqual([]);
    // ...and only this agent is affected.
    await expect(repo.listEffective({ workspaceId, agentId: other })).resolves.toMatchObject([
      { id: lib.id },
    ]);

    // Idempotent: excluding twice is not an error and writes no second row.
    const again = await SELF.fetch(
      `https://nadi.test/api/agents/${agentId}/skills/${lib.id}/exclusion`,
      {
        method: "POST",
        headers: { ...cookie(token), "Content-Type": "application/json" },
        body: JSON.stringify({ excluded: true }),
      },
    );
    expect(again.status).toBe(204);
    expect(await repo.listExcludedSkillIds(agentId)).toEqual([lib.id]);

    const included = await SELF.fetch(
      `https://nadi.test/api/agents/${agentId}/skills/${lib.id}/exclusion`,
      {
        method: "POST",
        headers: { ...cookie(token), "Content-Type": "application/json" },
        body: JSON.stringify({ excluded: false }),
      },
    );
    expect(included.status).toBe(204);
    expect(await repo.listExcludedSkillIds(agentId)).toEqual([]);
  });

  // A guessed id must not write an `agent_skill_exclusions` row across a
  // workspace boundary - the skill id comes straight off the URL.
  it("refuses to exclude a skill from another workspace", async () => {
    const { token, agentId } = await seedMemberWithAgent();
    const foreign = await seedOtherWorkspace();
    const repo = new AgentSkillRepository(drizzle(env.REGISTRY_DB, { schema }));
    const foreignSkill = await repo.create({
      workspaceId: foreign.workspaceId,
      agentId: null,
      name: "review",
      description: "Review",
      body: "Body",
    });

    const res = await SELF.fetch(
      `https://nadi.test/api/agents/${agentId}/skills/${foreignSkill.id}/exclusion`,
      {
        method: "POST",
        headers: { ...cookie(token), "Content-Type": "application/json" },
        body: JSON.stringify({ excluded: true }),
      },
    );
    expect(res.status).toBe(404);
    expect(await repo.listExcludedSkillIds(agentId)).toEqual([]);
  });

  // Private skills are archived, not excluded: an exclusion row on one is a
  // row resolution never reads, so the toggle would silently do nothing.
  it("refuses to exclude an agent-private skill", async () => {
    const { token, workspaceId, agentId } = await seedMemberWithAgent();
    const repo = new AgentSkillRepository(drizzle(env.REGISTRY_DB, { schema }));
    const own = await repo.create({
      workspaceId,
      agentId,
      name: "deploy",
      description: "Deploy",
      body: "Body",
    });

    const res = await SELF.fetch(
      `https://nadi.test/api/agents/${agentId}/skills/${own.id}/exclusion`,
      {
        method: "POST",
        headers: { ...cookie(token), "Content-Type": "application/json" },
        body: JSON.stringify({ excluded: true }),
      },
    );
    expect(res.status).toBe(404);
    expect(await repo.listExcludedSkillIds(agentId)).toEqual([]);
  });

  it("refuses an agentId the session does not own", async () => {
    const { token, workspaceId } = await seedMemberWithAgent();
    const foreign = await seedOtherWorkspace();
    const repo = new AgentSkillRepository(drizzle(env.REGISTRY_DB, { schema }));
    // A skill in the CALLER's own workspace, so only the agent id is foreign.
    const lib = await repo.create({
      workspaceId,
      agentId: null,
      name: "review",
      description: "Review",
      body: "Body",
    });

    const res = await SELF.fetch(
      `https://nadi.test/api/agents/${foreign.agentId}/skills/${lib.id}/exclusion`,
      {
        method: "POST",
        headers: { ...cookie(token), "Content-Type": "application/json" },
        body: JSON.stringify({ excluded: true }),
      },
    );
    expect(res.status).toBe(404);
    expect(await repo.listExcludedSkillIds(foreign.agentId)).toEqual([]);
  });

  it("400 when excluded is not a boolean", async () => {
    const { token, workspaceId, agentId } = await seedMemberWithAgent();
    const repo = new AgentSkillRepository(drizzle(env.REGISTRY_DB, { schema }));
    const lib = await repo.create({
      workspaceId,
      agentId: null,
      name: "review",
      description: "Review",
      body: "Body",
    });
    const res = await SELF.fetch(
      `https://nadi.test/api/agents/${agentId}/skills/${lib.id}/exclusion`,
      {
        method: "POST",
        headers: { ...cookie(token), "Content-Type": "application/json" },
        body: JSON.stringify({ excluded: "yes" }),
      },
    );
    expect(res.status).toBe(400);
    expect(await repo.listExcludedSkillIds(agentId)).toEqual([]);
  });

  it("405 on a wrong method for the agent skill routes", async () => {
    const { token, agentId } = await seedMemberWithAgent();
    const list = await SELF.fetch(`https://nadi.test/api/agents/${agentId}/skills`, {
      method: "POST",
      headers: cookie(token),
    });
    expect(list.status).toBe(405);
    const exclusion = await SELF.fetch(
      `https://nadi.test/api/agents/${agentId}/skills/whatever/exclusion`,
      { headers: cookie(token) },
    );
    expect(exclusion.status).toBe(405);
  });

  it("400 when enabled is not a boolean", async () => {
    const { token, workspaceId, agentId } = await seedMemberWithAgent();
    const repo = new AgentSkillRepository(drizzle(env.REGISTRY_DB, { schema }));
    const created = await repo.create({
      workspaceId,
      agentId,
      name: "review",
      description: "Review",
      body: "Body",
    });
    const res = await SELF.fetch(`https://nadi.test/api/skills/${created.id}/enabled`, {
      method: "POST",
      headers: { ...cookie(token), "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: "yes" }),
    });
    expect(res.status).toBe(400);
  });

  // The count is the whole point of one shared copy: it says how far an edit
  // reaches BEFORE it is made.
  it("annotates each library skill with how many agents it is live on", async () => {
    const { token, workspaceId, agentId } = await seedMemberWithAgent();
    const second = await seedAgent(workspaceId, "agent-second");
    const third = await seedAgent(workspaceId, "agent-third");
    const repo = new AgentSkillRepository(drizzle(env.REGISTRY_DB, { schema }));
    const shared = await repo.create({
      workspaceId,
      agentId: null,
      name: "review",
      description: "Review",
      body: "Body",
    });
    const narrow = await repo.create({
      workspaceId,
      agentId: null,
      name: "deploy",
      description: "Deploy",
      body: "Body",
    });
    await repo.excludeLibrarySkill({ agentId: second, skillId: narrow.id });
    await repo.create({
      workspaceId,
      agentId: third,
      name: "deploy",
      description: "Shadow",
      body: "Body",
    });

    const res = await SELF.fetch("https://nadi.test/api/skills", { headers: cookie(token) });
    expect(res.status).toBe(200);
    const { skills } = (await res.json()) as {
      skills: Array<{ id: string; liveOnAgentCount: number }>;
    };
    expect(Object.fromEntries(skills.map((skill) => [skill.id, skill.liveOnAgentCount]))).toEqual({
      [shared.id]: 3,
      [narrow.id]: 1,
    });
    expect(agentId).toBeTruthy();
  });

  // On an agent's own skills the number would always be 1 — noise, and a field
  // whose presence would imply the skill is shared.
  it("omits the count on an agent-scoped listing", async () => {
    const { token, workspaceId, agentId } = await seedMemberWithAgent();
    const repo = new AgentSkillRepository(drizzle(env.REGISTRY_DB, { schema }));
    await repo.create({
      workspaceId,
      agentId,
      name: "deploy",
      description: "Deploy",
      body: "Body",
    });
    const res = await SELF.fetch(`https://nadi.test/api/skills?agentId=${agentId}`, {
      headers: cookie(token),
    });
    const { skills } = (await res.json()) as { skills: Array<Record<string, unknown>> };
    expect(skills).toHaveLength(1);
    expect(skills[0]).not.toHaveProperty("liveOnAgentCount");
  });

  it("moves an agent's private skill into the library", async () => {
    const { token, workspaceId, agentId } = await seedMemberWithAgent();
    const other = await seedAgent(workspaceId, "agent-other");
    const repo = new AgentSkillRepository(drizzle(env.REGISTRY_DB, { schema }));
    const created = await repo.create({
      workspaceId,
      agentId,
      name: "deploy",
      description: "Deploy",
      body: "Body",
    });

    const res = await SELF.fetch(
      `https://nadi.test/api/skills/${created.id}/move-to-library?agentId=${agentId}`,
      { method: "POST", headers: cookie(token) },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { skill: { id: string } }).skill.id).toBe(created.id);

    // It is now the library's, and it reaches the agent that never had it.
    const listed = await SELF.fetch("https://nadi.test/api/skills", { headers: cookie(token) });
    const { skills } = (await listed.json()) as {
      skills: Array<{ id: string; liveOnAgentCount: number }>;
    };
    expect(skills).toMatchObject([{ id: created.id, liveOnAgentCount: 2 }]);
    await expect(repo.listEffective({ workspaceId, agentId: other })).resolves.toMatchObject([
      { id: created.id },
    ]);
  });

  // Without `?agentId=` the route is looking in the LIBRARY, where a private
  // skill is not — a bare 404 there reads as "no such skill" and hides the
  // real problem, which is that the caller never named the scope.
  it("400s a move that does not name the agent the skill belongs to", async () => {
    const { token, workspaceId, agentId } = await seedMemberWithAgent();
    const repo = new AgentSkillRepository(drizzle(env.REGISTRY_DB, { schema }));
    const created = await repo.create({
      workspaceId,
      agentId,
      name: "deploy",
      description: "Deploy",
      body: "Body",
    });
    const res = await SELF.fetch(`https://nadi.test/api/skills/${created.id}/move-to-library`, {
      method: "POST",
      headers: cookie(token),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/agentId/);
    // ...and nothing moved.
    const row = await repo.listActive({ workspaceId, agentId }, { includeDisabled: true });
    expect(row.map((s) => s.id)).toEqual([created.id]);
  });

  it("refuses a move when an active library skill already has that name", async () => {
    const { token, workspaceId, agentId } = await seedMemberWithAgent();
    const repo = new AgentSkillRepository(drizzle(env.REGISTRY_DB, { schema }));
    await repo.create({
      workspaceId,
      agentId: null,
      name: "deploy",
      description: "Library",
      body: "Body",
    });
    const created = await repo.create({
      workspaceId,
      agentId,
      name: "deploy",
      description: "Private",
      body: "Body",
    });

    const res = await SELF.fetch(
      `https://nadi.test/api/skills/${created.id}/move-to-library?agentId=${agentId}`,
      { method: "POST", headers: cookie(token) },
    );
    expect(res.status).toBe(409);
    // Human-readable, never a bare status code.
    expect(await res.text()).toMatch(/already active/i);
  });

  it("404s a move of a skill belonging to another workspace's agent", async () => {
    const { token } = await seedMemberWithAgent();
    const foreign = await seedOtherWorkspace();
    const repo = new AgentSkillRepository(drizzle(env.REGISTRY_DB, { schema }));
    const created = await repo.create({
      workspaceId: foreign.workspaceId,
      agentId: foreign.agentId,
      name: "deploy",
      description: "Deploy",
      body: "Body",
    });

    const res = await SELF.fetch(
      `https://nadi.test/api/skills/${created.id}/move-to-library?agentId=${foreign.agentId}`,
      { method: "POST", headers: cookie(token) },
    );
    expect(res.status).toBe(404);
    const still = await drizzle(env.REGISTRY_DB, { schema }).select().from(schema.skills).all();
    expect(still.find((s) => s.id === created.id)?.agentId).toBe(foreign.agentId);
  });

  it("copies a library skill onto an agent as its own", async () => {
    const { token, workspaceId, agentId } = await seedMemberWithAgent();
    const repo = new AgentSkillRepository(drizzle(env.REGISTRY_DB, { schema }));
    const library = await repo.create({
      workspaceId,
      agentId: null,
      name: "deploy",
      description: "Deploy",
      body: "Body",
    });

    const res = await SELF.fetch(`https://nadi.test/api/skills/${library.id}/copy-to-agent`, {
      method: "POST",
      headers: { ...cookie(token), "Content-Type": "application/json" },
      body: JSON.stringify({ agentId }),
    });
    expect(res.status).toBe(200);
    const { skill } = (await res.json()) as { skill: { id: string; name: string } };
    expect(skill.name).toBe("deploy");
    expect(skill.id).not.toBe(library.id);

    // The source stays in the library, and the copy shadows it here — so the
    // library skill is live on nobody once this is the only agent.
    const listed = await SELF.fetch("https://nadi.test/api/skills", { headers: cookie(token) });
    const { skills } = (await listed.json()) as {
      skills: Array<{ id: string; liveOnAgentCount: number }>;
    };
    expect(skills).toMatchObject([{ id: library.id, liveOnAgentCount: 0 }]);
    await expect(repo.listEffective({ workspaceId, agentId })).resolves.toMatchObject([
      { id: skill.id },
    ]);
  });

  it("refuses a copy when that agent already has an active skill of that name", async () => {
    const { token, workspaceId, agentId } = await seedMemberWithAgent();
    const repo = new AgentSkillRepository(drizzle(env.REGISTRY_DB, { schema }));
    const library = await repo.create({
      workspaceId,
      agentId: null,
      name: "deploy",
      description: "Library",
      body: "Body",
    });
    await repo.create({
      workspaceId,
      agentId,
      name: "deploy",
      description: "Private",
      body: "Body",
    });

    const res = await SELF.fetch(`https://nadi.test/api/skills/${library.id}/copy-to-agent`, {
      method: "POST",
      headers: { ...cookie(token), "Content-Type": "application/json" },
      body: JSON.stringify({ agentId }),
    });
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/already has a skill/i);
  });

  it("400s a copy with no target agent", async () => {
    const { token, workspaceId } = await seedMemberWithAgent();
    const repo = new AgentSkillRepository(drizzle(env.REGISTRY_DB, { schema }));
    const library = await repo.create({
      workspaceId,
      agentId: null,
      name: "deploy",
      description: "Deploy",
      body: "Body",
    });
    const res = await SELF.fetch(`https://nadi.test/api/skills/${library.id}/copy-to-agent`, {
      method: "POST",
      headers: { ...cookie(token), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  // The destination is taken off the BODY, so it is authorized separately: a
  // member of two workspaces must not be able to carry one's skill into the
  // other, and a stranger's agent id must not be writable at all.
  it("404s a copy onto an agent the session does not own", async () => {
    const { token, workspaceId } = await seedMemberWithAgent();
    const foreign = await seedOtherWorkspace();
    const repo = new AgentSkillRepository(drizzle(env.REGISTRY_DB, { schema }));
    const library = await repo.create({
      workspaceId,
      agentId: null,
      name: "deploy",
      description: "Deploy",
      body: "Body",
    });

    const res = await SELF.fetch(`https://nadi.test/api/skills/${library.id}/copy-to-agent`, {
      method: "POST",
      headers: { ...cookie(token), "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: foreign.agentId }),
    });
    expect(res.status).toBe(404);
    await expect(
      repo.listActive({ workspaceId: foreign.workspaceId, agentId: foreign.agentId }),
    ).resolves.toEqual([]);
  });

  it("401s both scope moves without a session", async () => {
    for (const path of ["move-to-library", "copy-to-agent"]) {
      const res = await SELF.fetch(`https://nadi.test/api/skills/skl_1/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: "agent-1" }),
      });
      expect(res.status).toBe(401);
    }
  });

  it("405s a GET on either scope move", async () => {
    const { token } = await seedMemberWithAgent();
    for (const path of ["move-to-library", "copy-to-agent"]) {
      const res = await SELF.fetch(`https://nadi.test/api/skills/skl_1/${path}`, {
        headers: cookie(token),
      });
      expect(res.status).toBe(405);
    }
  });

  // The sibling half of the guard above. `seedOtherWorkspace` makes user-1 a
  // NON-member of ws-2, so only `!target` ever fired there; this is the case the
  // guard's own comment describes — a member of two workspaces. Without the
  // workspace-equality check the insert succeeds and writes a row carrying ws-1's
  // `workspace_id` under a ws-2 agent: invisible to BOTH workspaces, because
  // `listActive` filters on workspace and the library listing on `agent_id IS NULL`.
  it("404s a copy onto an agent in another workspace the session IS a member of", async () => {
    const { token, workspaceId } = await seedMemberWithAgent();
    const foreign = await seedOtherWorkspace();
    const db = drizzle(env.REGISTRY_DB, { schema });
    await db.insert(schema.workspaceMembers).values({
      workspaceId: foreign.workspaceId,
      userId: "user-1",
      role: "member",
      // Later than the ws-1 membership, so the un-targeted source scope still
      // resolves to ws-1 (`resolveAgentScope` takes the earliest membership).
      createdAt: now + 1,
    });
    const repo = new AgentSkillRepository(db);
    const library = await repo.create({
      workspaceId,
      agentId: null,
      name: "deploy",
      description: "Deploy",
      body: "Body",
    });

    const res = await SELF.fetch(`https://nadi.test/api/skills/${library.id}/copy-to-agent`, {
      method: "POST",
      headers: { ...cookie(token), "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: foreign.agentId }),
    });
    expect(res.status).toBe(404);
    await expect(
      repo.listActive({ workspaceId: foreign.workspaceId, agentId: foreign.agentId }),
    ).resolves.toEqual([]);
    // Nothing anywhere: an orphan row would show up here and in no listing.
    const rows = await db.select().from(schema.skills).all();
    expect(rows.map((row) => row.id)).toEqual([library.id]);
  });

  /**
   * Library CRUD. Before this, a skill in the library was editable by NOTHING:
   * the chat tools scope every write to `thread.agentId`
   * (`src/agent/skill-management-tools.ts`), which cannot match
   * `agent_id IS NULL`, and this route had no create and no edit. The one
   * recovery a model reaches for — `create_skill` with the same name —
   * succeeds and forks a PRIVATE shadow, leaving every other agent on the
   * stale body.
   */
  describe("library CRUD", () => {
    it("creates a library skill, and lists it as shared", async () => {
      const { token, workspaceId, agentId } = await seedMemberWithAgent();

      const res = await SELF.fetch("https://nadi.test/api/skills", {
        method: "POST",
        headers: { ...cookie(token), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Deploy Notes", description: "Ship it", body: "# Deploy" }),
      });
      expect(res.status).toBe(201);
      const { skill } = (await res.json()) as { skill: { id: string; name: string } };
      // Normalised on the way in, exactly as the chat tool's name is.
      expect(skill.name).toBe("deploy-notes");

      const repo = new AgentSkillRepository(drizzle(env.REGISTRY_DB, { schema }));
      // Library scope, so it resolves for an agent that did nothing to get it.
      await expect(repo.listEffective({ workspaceId, agentId })).resolves.toMatchObject([
        { id: skill.id },
      ]);
      // ...and it reports its blast radius on the listing that offers the edit.
      const listed = await SELF.fetch("https://nadi.test/api/skills", { headers: cookie(token) });
      const { skills } = (await listed.json()) as {
        skills: Array<{ id: string; liveOnAgentCount: number }>;
      };
      expect(skills).toMatchObject([{ id: skill.id, liveOnAgentCount: 1 }]);
    });

    it("creates into an agent's private scope when one is named", async () => {
      const { token, workspaceId, agentId } = await seedMemberWithAgent();

      const res = await SELF.fetch(`https://nadi.test/api/skills?agentId=${agentId}`, {
        method: "POST",
        headers: { ...cookie(token), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "deploy", description: "d", body: "b" }),
      });
      expect(res.status).toBe(201);
      const repo = new AgentSkillRepository(drizzle(env.REGISTRY_DB, { schema }));
      await expect(repo.listActive({ workspaceId, agentId: null })).resolves.toEqual([]);
      await expect(repo.listActive({ workspaceId, agentId })).resolves.toHaveLength(1);
    });

    it("edits a library skill's body, name and description in place", async () => {
      const { token, workspaceId, agentId } = await seedMemberWithAgent();
      const repo = new AgentSkillRepository(drizzle(env.REGISTRY_DB, { schema }));
      const created = await repo.create({
        workspaceId,
        agentId: null,
        name: "deploy",
        description: "Deploy",
        body: "old",
      });

      const res = await SELF.fetch(`https://nadi.test/api/skills/${created.id}`, {
        method: "PATCH",
        headers: { ...cookie(token), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "release", description: "Release", body: "new" }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { skill: unknown }).skill).toMatchObject({
        id: created.id,
        name: "release",
        description: "Release",
        body: "new",
      });
      // The SAME row: one copy, one edit, every agent.
      await expect(repo.listEffective({ workspaceId, agentId })).resolves.toMatchObject([
        { id: created.id, body: "new" },
      ]);
    });

    it("leaves untouched fields alone on a partial edit", async () => {
      const { token, workspaceId } = await seedMemberWithAgent();
      const repo = new AgentSkillRepository(drizzle(env.REGISTRY_DB, { schema }));
      const created = await repo.create({
        workspaceId,
        agentId: null,
        name: "deploy",
        description: "Deploy",
        body: "old",
      });

      const res = await SELF.fetch(`https://nadi.test/api/skills/${created.id}`, {
        method: "PATCH",
        headers: { ...cookie(token), "Content-Type": "application/json" },
        body: JSON.stringify({ body: "new" }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { skill: unknown }).skill).toMatchObject({
        name: "deploy",
        description: "Deploy",
        body: "new",
      });
    });

    it("409s a create or a rename onto a name the library already has", async () => {
      const { token, workspaceId } = await seedMemberWithAgent();
      const repo = new AgentSkillRepository(drizzle(env.REGISTRY_DB, { schema }));
      await repo.create({
        workspaceId,
        agentId: null,
        name: "deploy",
        description: "Deploy",
        body: "b",
      });
      const other = await repo.create({
        workspaceId,
        agentId: null,
        name: "review",
        description: "Review",
        body: "b",
      });

      const created = await SELF.fetch("https://nadi.test/api/skills", {
        method: "POST",
        headers: { ...cookie(token), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "deploy", description: "d", body: "b" }),
      });
      expect(created.status).toBe(409);

      const renamed = await SELF.fetch(`https://nadi.test/api/skills/${other.id}`, {
        method: "PATCH",
        headers: { ...cookie(token), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "deploy" }),
      });
      expect(renamed.status).toBe(409);
      // The collided write left the row exactly as it was.
      await expect(
        repo.getActiveByName({ workspaceId, agentId: null, name: "review" }),
      ).resolves.toMatchObject({ id: other.id });
    });

    it("400s a name normalisation cannot rescue, and a non-string field", async () => {
      const { token } = await seedMemberWithAgent();

      const bad = await SELF.fetch("https://nadi.test/api/skills", {
        method: "POST",
        headers: { ...cookie(token), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "deploy!", description: "d", body: "b" }),
      });
      expect(bad.status).toBe(400);
      expect(await bad.text()).toMatch(/lowercase/);

      const missing = await SELF.fetch("https://nadi.test/api/skills", {
        method: "POST",
        headers: { ...cookie(token), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "deploy", description: "d" }),
      });
      expect(missing.status).toBe(400);

      const wrongType = await SELF.fetch("https://nadi.test/api/skills", {
        method: "POST",
        headers: { ...cookie(token), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "deploy", description: "d", body: 7 }),
      });
      expect(wrongType.status).toBe(400);
    });

    // The authorization idiom every other write on this route uses. Both
    // refusals matter: a foreign SKILL id must not be writable, and a foreign
    // AGENT id must not be addressable as a scope.
    it("refuses to edit another workspace's library skill", async () => {
      const { token } = await seedMemberWithAgent();
      const foreign = await seedOtherWorkspace();
      const repo = new AgentSkillRepository(drizzle(env.REGISTRY_DB, { schema }));
      const theirs = await repo.create({
        workspaceId: foreign.workspaceId,
        agentId: null,
        name: "deploy",
        description: "Deploy",
        body: "theirs",
      });

      const res = await SELF.fetch(`https://nadi.test/api/skills/${theirs.id}`, {
        method: "PATCH",
        headers: { ...cookie(token), "Content-Type": "application/json" },
        body: JSON.stringify({ body: "mine" }),
      });
      expect(res.status).toBe(404);
      await expect(
        repo.getActiveByName({ workspaceId: foreign.workspaceId, agentId: null, name: "deploy" }),
      ).resolves.toMatchObject({ body: "theirs" });
    });

    it("refuses to create into an agent the session does not own", async () => {
      const { token } = await seedMemberWithAgent();
      const foreign = await seedOtherWorkspace();

      const res = await SELF.fetch(`https://nadi.test/api/skills?agentId=${foreign.agentId}`, {
        method: "POST",
        headers: { ...cookie(token), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "deploy", description: "d", body: "b" }),
      });
      expect(res.status).toBe(404);
      const rows = await drizzle(env.REGISTRY_DB, { schema }).select().from(schema.skills).all();
      expect(rows).toEqual([]);
    });

    it("404s an edit of an archived skill rather than silently reviving it", async () => {
      const { token, workspaceId } = await seedMemberWithAgent();
      const repo = new AgentSkillRepository(drizzle(env.REGISTRY_DB, { schema }));
      const created = await repo.create({
        workspaceId,
        agentId: null,
        name: "deploy",
        description: "Deploy",
        body: "old",
      });
      await repo.archiveById({ workspaceId, agentId: null, id: created.id });

      const res = await SELF.fetch(`https://nadi.test/api/skills/${created.id}`, {
        method: "PATCH",
        headers: { ...cookie(token), "Content-Type": "application/json" },
        body: JSON.stringify({ body: "new" }),
      });
      expect(res.status).toBe(404);
      await expect(repo.listArchived({ workspaceId, agentId: null })).resolves.toMatchObject([
        { id: created.id, body: "old" },
      ]);
    });

    it("405s a method the skill routes do not serve", async () => {
      const { token } = await seedMemberWithAgent();
      const res = await SELF.fetch("https://nadi.test/api/skills/whatever", {
        method: "DELETE",
        headers: cookie(token),
      });
      expect(res.status).toBe(405);
    });

    it("401s a create and an edit without a session", async () => {
      const created = await SELF.fetch("https://nadi.test/api/skills", {
        method: "POST",
        body: JSON.stringify({ name: "a", description: "b", body: "c" }),
      });
      expect(created.status).toBe(401);
      const edited = await SELF.fetch("https://nadi.test/api/skills/x", {
        method: "PATCH",
        body: "{}",
      });
      expect(edited.status).toBe(401);
    });
  });

  // `countAgentsLiveOn` requires `archived_at IS NULL`, so on the archived tab it
  // can only ever answer zero. Omitting the field keeps that from being a D1
  // round-trip nobody can observe.
  it("does not count on the archived tab", async () => {
    const { token, workspaceId } = await seedMemberWithAgent();
    const repo = new AgentSkillRepository(drizzle(env.REGISTRY_DB, { schema }));
    const created = await repo.create({
      workspaceId,
      agentId: null,
      name: "deploy",
      description: "Deploy",
      body: "Body",
    });
    await repo.archiveById({ workspaceId, agentId: null, id: created.id });

    const res = await SELF.fetch("https://nadi.test/api/skills?archived=1", {
      headers: cookie(token),
    });
    const { skills } = (await res.json()) as { skills: Array<Record<string, unknown>> };
    expect(skills.map((s) => s.id)).toEqual([created.id]);
    expect(skills[0]).not.toHaveProperty("liveOnAgentCount");
  });
});
