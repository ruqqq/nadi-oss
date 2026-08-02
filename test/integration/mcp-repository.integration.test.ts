import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../src/db/schema";
import { applyRegistryTestSchema } from "./helpers/registry";
import { McpServerRepository } from "../../src/db/repositories/mcp-servers";

const now = 1_800_000_000_000;

function repo() {
  return new McpServerRepository(drizzle(env.REGISTRY_DB, { schema }));
}

async function seedWorkspace(id = "ws-1") {
  const db = drizzle(env.REGISTRY_DB, { schema });
  await db.insert(schema.workspaces).values({ id, name: id, createdAt: now });
  return id;
}

describe("McpServerRepository", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });
  beforeEach(async () => {
    const db = drizzle(env.REGISTRY_DB, { schema });
    await db.delete(schema.mcpToolPolicies);
    await db.delete(schema.mcpServers);
    await db.delete(schema.workspaces);
  });

  it("creates a server with a generated id and lists it", async () => {
    const ws = await seedWorkspace();
    const created = await repo().create(ws, { name: "GitHub", url: "https://mcp.example/sse" });
    expect(created.id).toMatch(/^[a-z][a-z0-9]*$/);
    expect(created.enabled).toBe(true);
    const list = await repo().list(ws);
    expect(list.map((s) => s.id)).toContain(created.id);
  });

  it("updates name and enabled", async () => {
    const ws = await seedWorkspace();
    const created = await repo().create(ws, { name: "A", url: "https://a.example/mcp" });
    const updated = await repo().update(created.id, { name: "B", enabled: false });
    expect(updated?.name).toBe("B");
    expect(updated?.enabled).toBe(false);
  });

  it("cascade-deletes the server's tool policies", async () => {
    const ws = await seedWorkspace();
    const created = await repo().create(ws, { name: "A", url: "https://a.example/mcp" });
    await repo().setPolicies(ws, created.id, [{ toolName: "search", policy: "deny" }]);
    await repo().delete(created.id);
    expect(await repo().getById(created.id)).toBeUndefined();
    expect(await repo().listPolicies(created.id)).toHaveLength(0);
  });

  it("setPolicies upserts a tool's policy without duplicating rows", async () => {
    const ws = await seedWorkspace();
    const s = await repo().create(ws, { name: "A", url: "https://a.example/mcp" });
    await repo().setPolicies(ws, s.id, [{ toolName: "search", policy: "approval_required" }]);
    await repo().setPolicies(ws, s.id, [{ toolName: "search", policy: "auto_allow" }]);
    const policies = await repo().listPolicies(s.id);
    expect(policies).toHaveLength(1);
    expect(policies[0]?.policy).toBe("auto_allow");
  });
});
