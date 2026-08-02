import { SELF, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../src/db/schema";
import { getMcpOAuthTokens, putMcpOAuthTokens } from "../../src/mcp/oauth-store";
import { applyRegistryTestSchema } from "./helpers/registry";

const now = 1_800_000_000_000;

async function seedMember(opts?: { token?: string; workspaceId?: string }) {
  const db = drizzle(env.REGISTRY_DB, { schema });
  const userId = "user-1";
  const token = opts?.token ?? "live-token";
  const workspaceId = opts?.workspaceId ?? "ws-1";
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
  return { token, workspaceId, userId };
}

const cookie = (token: string) => ({ cookie: `better-auth.session_token=${token}` });

describe("mcp routes — servers CRUD", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });
  beforeEach(async () => {
    const db = drizzle(env.REGISTRY_DB, { schema });
    await db.delete(schema.mcpToolPolicies);
    await db.delete(schema.mcpServers);
    await db.delete(schema.workspaceMembers);
    await db.delete(schema.workspaces);
    await db.delete(schema.sessions);
    await db.delete(schema.users);
  });

  it("401 without a session", async () => {
    const res = await SELF.fetch("https://nadi.test/api/mcp/servers");
    expect(res.status).toBe(401);
  });

  it("creates, lists, updates, and deletes a server", async () => {
    const { token } = await seedMember();

    const created = await SELF.fetch("https://nadi.test/api/mcp/servers", {
      method: "POST",
      headers: { ...cookie(token), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "GitHub", url: "https://mcp.example/sse" }),
    });
    expect(created.status).toBe(201);
    const { server } = (await created.json()) as { server: { id: string; enabled: boolean } };
    expect(server.enabled).toBe(true);

    const listed = await SELF.fetch("https://nadi.test/api/mcp/servers", {
      headers: cookie(token),
    });
    const { servers } = (await listed.json()) as { servers: Array<{ id: string }> };
    expect(servers.map((s) => s.id)).toContain(server.id);

    const patched = await SELF.fetch(`https://nadi.test/api/mcp/servers/${server.id}`, {
      method: "PATCH",
      headers: { ...cookie(token), "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { server: { enabled: boolean } }).server.enabled).toBe(false);

    const removed = await SELF.fetch(`https://nadi.test/api/mcp/servers/${server.id}`, {
      method: "DELETE",
      headers: cookie(token),
    });
    expect(removed.status).toBe(204);
  });

  it("rejects an invalid url on create", async () => {
    const { token } = await seedMember();
    const res = await SELF.fetch("https://nadi.test/api/mcp/servers", {
      method: "POST",
      headers: { ...cookie(token), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Bad", url: "not-a-url" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an empty name on create", async () => {
    const { token } = await seedMember();
    const res = await SELF.fetch("https://nadi.test/api/mcp/servers", {
      method: "POST",
      headers: { ...cookie(token), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "  ", url: "https://mcp.example/sse" }),
    });
    expect(res.status).toBe(400);
  });

  it("404 for a server in another workspace", async () => {
    const { token } = await seedMember();
    const db = drizzle(env.REGISTRY_DB, { schema });
    await db.insert(schema.workspaces).values({ id: "ws-other", name: "other", createdAt: now });
    await db.insert(schema.mcpServers).values({
      id: "sother",
      workspaceId: "ws-other",
      name: "X",
      url: "https://x.example/mcp",
      enabled: true,
      createdAt: now,
    });
    const res = await SELF.fetch("https://nadi.test/api/mcp/servers/sother", {
      method: "DELETE",
      headers: cookie(token),
    });
    expect(res.status).toBe(404);
  });

  it("clears stored OAuth tokens when the server is deleted", async () => {
    const { token, workspaceId } = await seedMember();
    const db = drizzle(env.REGISTRY_DB, { schema });
    await db.insert(schema.mcpServers).values({
      id: "sdelauth",
      workspaceId,
      name: "A",
      url: "https://a.example/mcp",
      enabled: true,
      createdAt: now,
    });
    await putMcpOAuthTokens(env, workspaceId, "sdelauth", {
      access_token: "at",
      token_type: "bearer",
    });
    expect(await getMcpOAuthTokens(env, workspaceId, "sdelauth")).not.toBeUndefined();

    const res = await SELF.fetch("https://nadi.test/api/mcp/servers/sdelauth", {
      method: "DELETE",
      headers: cookie(token),
    });
    expect(res.status).toBe(204);
    expect(await getMcpOAuthTokens(env, workspaceId, "sdelauth")).toBeUndefined();
  });
});

describe("mcp routes — authorize", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });
  beforeEach(async () => {
    const db = drizzle(env.REGISTRY_DB, { schema });
    await db.delete(schema.mcpToolPolicies);
    await db.delete(schema.mcpServers);
    await db.delete(schema.workspaceMembers);
    await db.delete(schema.workspaces);
    await db.delete(schema.sessions);
    await db.delete(schema.users);
  });

  // NOTE (live-verify): the { authUrl } / { ready: true } success branches call
  // beginServerAuth → addMcpServer against the real server URL and need a live
  // OAuth MCP server + egress (the harness would hang on the unreachable connect),
  // so only the pre-DO guard branches (401/404) are asserted here. See
  // docs/superpowers/specs/2026-06-28-mcp-oauth-spike2-findings.md.

  it("401 without a session", async () => {
    const res = await SELF.fetch("https://nadi.test/api/mcp/servers/sx/authorize", {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  it("404 for an unknown server", async () => {
    const { token } = await seedMember();
    const res = await SELF.fetch("https://nadi.test/api/mcp/servers/missing/authorize", {
      method: "POST",
      headers: cookie(token),
    });
    expect(res.status).toBe(404);
  });

  it("404 for a server in another workspace", async () => {
    const { token } = await seedMember();
    const db = drizzle(env.REGISTRY_DB, { schema });
    await db.insert(schema.workspaces).values({ id: "ws-other", name: "o", createdAt: now });
    await db.insert(schema.mcpServers).values({
      id: "sother",
      workspaceId: "ws-other",
      name: "X",
      url: "https://x.example/mcp",
      enabled: true,
      createdAt: now,
    });
    const res = await SELF.fetch("https://nadi.test/api/mcp/servers/sother/authorize", {
      method: "POST",
      headers: cookie(token),
    });
    expect(res.status).toBe(404);
  });

  it("405 for a non-POST method", async () => {
    const res = await SELF.fetch("https://nadi.test/api/mcp/servers/sx/authorize", {
      method: "GET",
    });
    expect(res.status).toBe(405);
  });
});

describe("mcp routes — policies", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });
  beforeEach(async () => {
    const db = drizzle(env.REGISTRY_DB, { schema });
    await db.delete(schema.mcpToolPolicies);
    await db.delete(schema.mcpServers);
    await db.delete(schema.workspaceMembers);
    await db.delete(schema.workspaces);
    await db.delete(schema.sessions);
    await db.delete(schema.users);
  });

  it("sets per-tool policies for a server", async () => {
    const { token, workspaceId } = await seedMember();
    const db = drizzle(env.REGISTRY_DB, { schema });
    await db.insert(schema.mcpServers).values({
      id: "ssrv1",
      workspaceId,
      name: "A",
      url: "https://a.example/mcp",
      enabled: true,
      createdAt: now,
    });

    const res = await SELF.fetch("https://nadi.test/api/mcp/servers/ssrv1/policies", {
      method: "PUT",
      headers: { ...cookie(token), "Content-Type": "application/json" },
      body: JSON.stringify({ policies: [{ toolName: "search", policy: "deny" }] }),
    });
    expect(res.status).toBe(200);
    const { policies } = (await res.json()) as {
      policies: Array<{ toolName: string; policy: string }>;
    };
    expect(policies).toEqual([expect.objectContaining({ toolName: "search", policy: "deny" })]);
  });

  it("rejects an invalid policy value", async () => {
    const { token, workspaceId } = await seedMember();
    const db = drizzle(env.REGISTRY_DB, { schema });
    await db.insert(schema.mcpServers).values({
      id: "ssrv2",
      workspaceId,
      name: "A",
      url: "https://a.example/mcp",
      enabled: true,
      createdAt: now,
    });
    const res = await SELF.fetch("https://nadi.test/api/mcp/servers/ssrv2/policies", {
      method: "PUT",
      headers: { ...cookie(token), "Content-Type": "application/json" },
      body: JSON.stringify({ policies: [{ toolName: "search", policy: "nonsense" }] }),
    });
    expect(res.status).toBe(400);
  });

  it("404 for policies on an unknown server", async () => {
    const { token } = await seedMember();
    const res = await SELF.fetch("https://nadi.test/api/mcp/servers/missing/policies", {
      method: "PUT",
      headers: { ...cookie(token), "Content-Type": "application/json" },
      body: JSON.stringify({ policies: [] }),
    });
    expect(res.status).toBe(404);
  });

  it("401 on policies without a session", async () => {
    const res = await SELF.fetch("https://nadi.test/api/mcp/servers/whatever/policies", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ policies: [] }),
    });
    expect(res.status).toBe(401);
  });

  it("400 when policies is not an array", async () => {
    const { token, workspaceId } = await seedMember();
    const db = drizzle(env.REGISTRY_DB, { schema });
    await db.insert(schema.mcpServers).values({
      id: "snarr",
      workspaceId,
      name: "A",
      url: "https://a.example/mcp",
      enabled: true,
      createdAt: now,
    });
    const res = await SELF.fetch("https://nadi.test/api/mcp/servers/snarr/policies", {
      method: "PUT",
      headers: { ...cookie(token), "Content-Type": "application/json" },
      body: JSON.stringify({ policies: "oops" }),
    });
    expect(res.status).toBe(400);
  });

  it("400 on a null policy entry", async () => {
    const { token, workspaceId } = await seedMember();
    const db = drizzle(env.REGISTRY_DB, { schema });
    await db.insert(schema.mcpServers).values({
      id: "snull",
      workspaceId,
      name: "A",
      url: "https://a.example/mcp",
      enabled: true,
      createdAt: now,
    });
    const res = await SELF.fetch("https://nadi.test/api/mcp/servers/snull/policies", {
      method: "PUT",
      headers: { ...cookie(token), "Content-Type": "application/json" },
      body: JSON.stringify({ policies: [null] }),
    });
    expect(res.status).toBe(400);
  });
});

describe("mcp routes — tools discovery", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });
  beforeEach(async () => {
    const db = drizzle(env.REGISTRY_DB, { schema });
    await db.delete(schema.mcpToolPolicies);
    await db.delete(schema.mcpServers);
    await db.delete(schema.workspaceMembers);
    await db.delete(schema.workspaces);
    await db.delete(schema.sessions);
    await db.delete(schema.users);
  });

  it("401 without a session", async () => {
    const res = await SELF.fetch("https://nadi.test/api/mcp/servers/whatever/tools");
    expect(res.status).toBe(401);
  });

  it("404 for an unknown server", async () => {
    const { token } = await seedMember();
    const res = await SELF.fetch("https://nadi.test/api/mcp/servers/missing/tools", {
      headers: cookie(token),
    });
    expect(res.status).toBe(404);
  });

  // NOTE: The 502 "server unreachable" test (exercises route → getAgentByName → DO →
  // addMcpServer(unreachable) → throw → 502) has been removed because in the miniflare
  // test harness the connection attempt to an unreachable MCP server either hangs
  // indefinitely or surfaces a non-throwing failure state rather than throwing cleanly.
  // The discovery success path (real tools returned and merged with policies) and the
  // 502 failure path both require manual verification against a deploy with a real
  // (or deliberately unreachable) MCP server.
});
