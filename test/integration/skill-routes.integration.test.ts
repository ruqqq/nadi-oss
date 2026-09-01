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

const cookie = (token: string) => ({ cookie: `better-auth.session_token=${token}` });

describe("skill routes", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });
  beforeEach(async () => {
    const db = drizzle(env.REGISTRY_DB, { schema });
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
});
