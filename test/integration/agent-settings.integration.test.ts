import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registryDb } from "../../src/db/client";
import { AgentSettingsRepository } from "../../src/db/repositories/agent-settings";
import { WorkspaceRepository } from "../../src/db/repositories/workspaces";
import {
  accounts,
  agents,
  mcpServers,
  mcpToolPolicies,
  providerConfigs,
  sessions,
  threadIndex,
  users,
  verifications,
  workspaceMembers,
  workspaces,
} from "../../src/db/schema";
import { applyRegistryTestSchema } from "./helpers/registry";

const now = 1_800_000_000_000;

async function clearRegistry() {
  const db = registryDb(env);
  await db.delete(providerConfigs);
  await db.delete(mcpToolPolicies);
  await db.delete(mcpServers);
  await db.delete(threadIndex);
  await db.delete(agents);
  await db.delete(workspaceMembers);
  await db.delete(workspaces);
  await db.delete(accounts);
  await db.delete(sessions);
  await db.delete(verifications);
  await db.delete(users);
}

async function seedUser(id: string) {
  const db = registryDb(env);
  await db.insert(users).values({
    id,
    email: `${id}@example.com`,
    name: id,
    createdAt: new Date(now),
    emailVerified: true,
    image: null,
    updatedAt: new Date(now),
  });
}

async function seedWorkspace(input: { id: string; name?: string; createdAt?: number }) {
  const db = registryDb(env);
  await db.insert(workspaces).values({
    id: input.id,
    name: input.name ?? input.id,
    createdAt: input.createdAt ?? now,
  });
}

async function seedWorkspaceMember(input: {
  workspaceId: string;
  userId: string;
  role: "owner" | "member";
  createdAt: number;
}) {
  const db = registryDb(env);
  await db.insert(workspaceMembers).values(input);
}

async function seedAgent(input: {
  id: string;
  workspaceId: string;
  name?: string;
  systemPrompt?: string;
  provider?: string;
  model?: string;
  createdAt: number;
}) {
  const db = registryDb(env);
  await db.insert(agents).values({
    id: input.id,
    workspaceId: input.workspaceId,
    name: input.name ?? input.id,
    systemPrompt: input.systemPrompt ?? `Prompt for ${input.id}`,
    provider: input.provider ?? "openai",
    model: input.model ?? "gpt-4o-mini",
    createdAt: input.createdAt,
  });
}

describe("WorkspaceRepository.getCurrentWorkspaceForOwner", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  beforeEach(async () => {
    await clearRegistry();
  });

  it("returns the earliest owner workspace for a user", async () => {
    await seedUser("owner-1");
    await seedWorkspace({ id: "workspace-newer-member", name: "Newer Member", createdAt: 10 });
    await seedWorkspace({ id: "workspace-later-owner", name: "Later Owner", createdAt: 20 });
    await seedWorkspace({
      id: "workspace-earliest-owner",
      name: "Earliest Owner",
      createdAt: 30,
    });
    await seedWorkspaceMember({
      workspaceId: "workspace-newer-member",
      userId: "owner-1",
      role: "member",
      createdAt: 1,
    });
    await seedWorkspaceMember({
      workspaceId: "workspace-later-owner",
      userId: "owner-1",
      role: "owner",
      createdAt: 3,
    });
    await seedWorkspaceMember({
      workspaceId: "workspace-earliest-owner",
      userId: "owner-1",
      role: "owner",
      createdAt: 2,
    });

    const repo = new WorkspaceRepository(registryDb(env));

    await expect(repo.getCurrentWorkspaceForOwner("owner-1")).resolves.toEqual({
      id: "workspace-earliest-owner",
      name: "Earliest Owner",
      createdAt: 30,
    });
  });

  it("returns undefined for non-owner members", async () => {
    await seedUser("member-1");
    await seedWorkspace({ id: "workspace-member-only", name: "Member Only" });
    await seedWorkspaceMember({
      workspaceId: "workspace-member-only",
      userId: "member-1",
      role: "member",
      createdAt: 1,
    });

    const repo = new WorkspaceRepository(registryDb(env));

    await expect(repo.getCurrentWorkspaceForOwner("member-1")).resolves.toBeUndefined();
  });
});

describe("AgentSettingsRepository", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  beforeEach(async () => {
    await clearRegistry();
  });

  it("resolves the default agent as the earliest workspace agent and updates only provided fields", async () => {
    await seedWorkspace({ id: "workspace-1" });
    await seedWorkspace({ id: "workspace-2" });
    await seedAgent({
      id: "agent-later",
      workspaceId: "workspace-1",
      systemPrompt: "Later prompt",
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      createdAt: 20,
    });
    await seedAgent({
      id: "agent-earliest",
      workspaceId: "workspace-1",
      systemPrompt: "Original prompt",
      provider: "openai",
      model: "gpt-4o-mini",
      createdAt: 10,
    });
    await seedAgent({
      id: "agent-outside-earlier",
      workspaceId: "workspace-2",
      createdAt: 1,
    });
    const repo = new AgentSettingsRepository(registryDb(env));

    await expect(repo.getAgentSettings("workspace-1", { kind: "default" })).resolves.toMatchObject({
      id: "agent-earliest",
      systemPrompt: "Original prompt",
      provider: "openai",
      model: "gpt-4o-mini",
    });

    const updated = await repo.updateAgentSettings(
      "workspace-1",
      { kind: "default" },
      {
        systemPrompt: "Updated prompt",
        provider: "anthropic",
      },
    );

    expect(updated).toMatchObject({
      id: "agent-earliest",
      workspaceId: "workspace-1",
      name: "agent-earliest",
      systemPrompt: "Updated prompt",
      provider: "anthropic",
      model: "gpt-4o-mini",
      createdAt: 10,
    });
    await expect(
      repo.getAgentSettings("workspace-1", { kind: "id", agentId: "agent-later" }),
    ).resolves.toMatchObject({
      id: "agent-later",
      systemPrompt: "Later prompt",
      provider: "anthropic",
      model: "claude-3-5-sonnet",
    });
  });

  it("returns the current row unchanged for an empty patch", async () => {
    await seedWorkspace({ id: "workspace-1" });
    await seedAgent({
      id: "agent-default",
      workspaceId: "workspace-1",
      systemPrompt: "Keep prompt",
      provider: "openai",
      model: "gpt-4o-mini",
      createdAt: 10,
    });
    const repo = new AgentSettingsRepository(registryDb(env));

    const current = await repo.getAgentSettings("workspace-1", { kind: "default" });
    const updated = await repo.updateAgentSettings("workspace-1", { kind: "default" }, {});

    expect(updated).toEqual(current);
  });

  it("does not return or update an explicit agent outside the workspace", async () => {
    await seedWorkspace({ id: "workspace-1" });
    await seedWorkspace({ id: "workspace-2" });
    await seedAgent({
      id: "agent-outside",
      workspaceId: "workspace-2",
      systemPrompt: "Outside prompt",
      provider: "openai",
      model: "gpt-4o-mini",
      createdAt: 1,
    });
    const repo = new AgentSettingsRepository(registryDb(env));

    await expect(
      repo.getAgentSettings("workspace-1", { kind: "id", agentId: "agent-outside" }),
    ).resolves.toBeUndefined();
    await expect(
      repo.updateAgentSettings(
        "workspace-1",
        { kind: "id", agentId: "agent-outside" },
        { model: "gpt-4.1" },
      ),
    ).resolves.toBeUndefined();
    await expect(
      repo.getAgentSettings("workspace-2", { kind: "id", agentId: "agent-outside" }),
    ).resolves.toMatchObject({
      id: "agent-outside",
      model: "gpt-4o-mini",
    });
  });
});
