import { SELF, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../src/db/schema";
import { AgentMemoryRepository } from "../../src/db/repositories/agent-memories";
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

describe("memory routes", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });
  beforeEach(async () => {
    const db = drizzle(env.REGISTRY_DB, { schema });
    await db.delete(schema.agentMemories);
    await db.delete(schema.workspaceMembers);
    await db.delete(schema.agents);
    await db.delete(schema.workspaces);
    await db.delete(schema.sessions);
    await db.delete(schema.users);
  });

  it("401 without a session", async () => {
    const res = await SELF.fetch("https://nadi.test/api/memories");
    expect(res.status).toBe(401);
  });

  it("lists active memories and archives one", async () => {
    const { token, workspaceId, agentId } = await seedMemberWithAgent();
    const repo = new AgentMemoryRepository(drizzle(env.REGISTRY_DB, { schema }));
    const memory = await repo.create({ workspaceId, agentId, content: "A fact", title: "Fact" });

    const listed = await SELF.fetch("https://nadi.test/api/memories", { headers: cookie(token) });
    expect(listed.status).toBe(200);
    const { memories } = (await listed.json()) as {
      memories: Array<{ id: string; title: string }>;
    };
    expect(memories).toMatchObject([{ id: memory.id, title: "Fact", content: "A fact" }]);

    const archived = await SELF.fetch(`https://nadi.test/api/memories/${memory.id}/archive`, {
      method: "POST",
      headers: cookie(token),
    });
    expect(archived.status).toBe(200);

    const archivedList = await SELF.fetch("https://nadi.test/api/memories?archived=1", {
      headers: cookie(token),
    });
    const body = (await archivedList.json()) as { memories: Array<{ id: string }> };
    expect(body.memories.map((m) => m.id)).toEqual([memory.id]);

    const restored = await SELF.fetch(`https://nadi.test/api/memories/${memory.id}/restore`, {
      method: "POST",
      headers: cookie(token),
    });
    expect(restored.status).toBe(200);
  });

  it("404 for a memory in another workspace", async () => {
    const { token } = await seedMemberWithAgent();
    const res = await SELF.fetch("https://nadi.test/api/memories/nope/archive", {
      method: "POST",
      headers: cookie(token),
    });
    expect(res.status).toBe(404);
  });
});
