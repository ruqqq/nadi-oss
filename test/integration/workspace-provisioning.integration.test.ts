import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registryDb } from "../../src/db/client";
import { WorkspaceRepository } from "../../src/db/repositories/workspaces";
import {
  agents,
  users,
  workspaceMembers,
  workspaceSandboxSettings,
  workspaces,
} from "../../src/db/schema";
import { applyRegistryTestSchema } from "./helpers/registry";

const DEFAULT_AGENT = {
  name: "Assistant",
  systemPrompt: "You are Nadi, a helpful AI assistant. Be concise and clear.",
  provider: "openai-oauth",
  model: "gpt-5.4-mini",
};

describe("WorkspaceRepository.provisionForOwner", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  beforeEach(async () => {
    const db = registryDb(env);
    await db.delete(agents);
    await db.delete(workspaceMembers);
    await db.delete(workspaces);
    await db.delete(users);
    await db.insert(users).values({
      id: "user-1",
      email: "user1@example.com",
      emailVerified: true,
      createdAt: new Date(1),
      updatedAt: new Date(1),
    });
  });

  it("creates a workspace, an owner membership, and a default agent for a new user", async () => {
    const db = registryDb(env);
    const repo = new WorkspaceRepository(db);

    const workspace = await repo.provisionForOwner({
      userId: "user-1",
      now: 100,
      defaultAgent: DEFAULT_AGENT,
    });

    expect(workspace.id).toBeTruthy();
    expect(workspace.name).toBeTruthy();

    const current = await repo.getCurrentWorkspaceForOwner("user-1");
    expect(current?.id).toBe(workspace.id);

    const members = await db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspace.id))
      .all();
    expect(members).toHaveLength(1);
    expect(members[0]?.userId).toBe("user-1");
    expect(members[0]?.role).toBe("owner");

    const agentRows = await db
      .select()
      .from(agents)
      .where(eq(agents.workspaceId, workspace.id))
      .all();
    expect(agentRows).toHaveLength(1);
    expect(agentRows[0]?.provider).toBe(DEFAULT_AGENT.provider);
    expect(agentRows[0]?.model).toBe(DEFAULT_AGENT.model);
    expect(agentRows[0]?.systemPrompt).toBe(DEFAULT_AGENT.systemPrompt);
  });

  it("seeds a Cloudflare compute default when defaultSandbox is provided", async () => {
    const db = registryDb(env);
    const repo = new WorkspaceRepository(db);

    const workspace = await repo.provisionForOwner({
      userId: "user-1",
      now: 100,
      defaultAgent: DEFAULT_AGENT,
      defaultSandbox: {
        provider: "cloudflare",
        enabled: true,
        providerConfigJson: JSON.stringify({ kind: "cloudflare" }),
      },
    });

    const settings = await db
      .select()
      .from(workspaceSandboxSettings)
      .where(eq(workspaceSandboxSettings.workspaceId, workspace.id))
      .get();
    expect(settings?.provider).toBe("cloudflare");
    expect(settings?.enabled).toBe(true);
    expect(settings?.providerConfigJson).toBe(JSON.stringify({ kind: "cloudflare" }));
  });

  it("seeds no compute settings row when defaultSandbox is omitted", async () => {
    const db = registryDb(env);
    const repo = new WorkspaceRepository(db);

    const workspace = await repo.provisionForOwner({
      userId: "user-1",
      now: 100,
      defaultAgent: DEFAULT_AGENT,
    });

    const settings = await db
      .select()
      .from(workspaceSandboxSettings)
      .where(eq(workspaceSandboxSettings.workspaceId, workspace.id))
      .get();
    expect(settings).toBeUndefined();
  });

  it("is idempotent — a second call returns the existing workspace and creates no duplicate", async () => {
    const db = registryDb(env);
    const repo = new WorkspaceRepository(db);

    const first = await repo.provisionForOwner({
      userId: "user-1",
      now: 100,
      defaultAgent: DEFAULT_AGENT,
    });
    const second = await repo.provisionForOwner({
      userId: "user-1",
      now: 200,
      defaultAgent: DEFAULT_AGENT,
    });

    expect(second.id).toBe(first.id);

    const allWorkspaces = await db.select().from(workspaces).all();
    expect(allWorkspaces).toHaveLength(1);

    const allMembers = await db.select().from(workspaceMembers).all();
    expect(allMembers).toHaveLength(1);

    const allAgents = await db.select().from(agents).all();
    expect(allAgents).toHaveLength(1);
  });
});
