import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AgentMemoryRepository } from "../../src/db/repositories/agent-memories";
import { resolveMemoryIndex } from "../../src/agent/memory-index";
import * as schema from "../../src/db/schema";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";

describe("AgentMemoryRepository", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  beforeEach(async () => {
    const db = drizzle(env.REGISTRY_DB, { schema });
    await db.delete(schema.agentMemories);
    await db.delete(schema.threadIndex);
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-memory-a",
      agentId: "agent-memory-a",
      threadId: "thread-memory-a",
    });
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-memory-a",
      agentId: "agent-memory-b",
      threadId: "thread-memory-b",
    });
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-memory-b",
      agentId: "agent-memory-a",
      threadId: "thread-memory-c",
    });
  });

  it("creates, searches, updates, and archives agent-scoped memories", async () => {
    const repo = new AgentMemoryRepository(drizzle(env.REGISTRY_DB, { schema }));
    const created = await repo.create({
      workspaceId: "workspace-memory-a",
      agentId: "agent-memory-a",
      sourceThreadId: "thread-memory-a",
      title: "Editor preference",
      kind: "preference",
      content: "The user prefers compact TypeScript examples.",
    });

    expect(created).toMatchObject({
      workspaceId: "workspace-memory-a",
      agentId: "agent-memory-a",
      sourceThreadId: "thread-memory-a",
      title: "Editor preference",
      kind: "preference",
      content: "The user prefers compact TypeScript examples.",
      archivedAt: null,
    });

    expect(
      await repo.search({
        workspaceId: "workspace-memory-a",
        agentId: "agent-memory-a",
        query: "TypeScript examples",
      }),
    ).toEqual([expect.objectContaining({ id: created.id })]);

    const updated = await repo.update({
      workspaceId: "workspace-memory-a",
      agentId: "agent-memory-a",
      id: created.id,
      title: "Code style",
      kind: "workflow",
      content: "The user prefers concise TypeScript examples with explicit types.",
    });
    expect(updated).toMatchObject({
      id: created.id,
      title: "Code style",
      kind: "workflow",
      content: "The user prefers concise TypeScript examples with explicit types.",
    });
    expect(updated?.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);

    expect(
      await repo.search({
        workspaceId: "workspace-memory-a",
        agentId: "agent-memory-a",
        query: "explicit types",
      }),
    ).toEqual([expect.objectContaining({ id: created.id })]);

    await expect(
      repo.archive({
        workspaceId: "workspace-memory-a",
        agentId: "agent-memory-a",
        id: created.id,
      }),
    ).resolves.toBe(true);
    await expect(
      repo.search({
        workspaceId: "workspace-memory-a",
        agentId: "agent-memory-a",
        query: "TypeScript",
      }),
    ).resolves.toEqual([]);
  });

  it("does not leak memories across agents or workspaces", async () => {
    const repo = new AgentMemoryRepository(drizzle(env.REGISTRY_DB, { schema }));
    await repo.create({
      workspaceId: "workspace-memory-a",
      agentId: "agent-memory-a",
      content: "Project codename is Cedar.",
      title: "Codename",
    });
    await repo.create({
      workspaceId: "workspace-memory-a",
      agentId: "agent-memory-b",
      content: "Project codename is Birch.",
      title: "Codename",
    });
    await repo.create({
      workspaceId: "workspace-memory-b",
      agentId: "agent-memory-a",
      content: "Project codename is Aspen.",
      title: "Codename",
    });

    const sameAgent = await repo.search({
      workspaceId: "workspace-memory-a",
      agentId: "agent-memory-a",
      query: "codename",
    });
    expect(sameAgent.map((memory) => memory.content)).toEqual(["Project codename is Cedar."]);
  });

  it("ranks exact and title matches before weaker content matches deterministically", async () => {
    const repo = new AgentMemoryRepository(drizzle(env.REGISTRY_DB, { schema }));
    await repo.create({
      workspaceId: "workspace-memory-a",
      agentId: "agent-memory-a",
      title: "General notes",
      content: "Use the blue deployment checklist for releases.",
    });
    await repo.create({
      workspaceId: "workspace-memory-a",
      agentId: "agent-memory-a",
      title: "Blue deployment checklist",
      content: "Run migrations before deploying.",
    });
    await repo.create({
      workspaceId: "workspace-memory-a",
      agentId: "agent-memory-a",
      title: "Deployment",
      content: "The exact phrase blue deployment checklist appears here but with a longer body.",
    });

    const results = await repo.search({
      workspaceId: "workspace-memory-a",
      agentId: "agent-memory-a",
      query: "blue deployment checklist",
      limit: 3,
    });

    expect(results.map((memory) => memory.title)).toEqual([
      "Blue deployment checklist",
      "Deployment",
      "General notes",
    ]);
  });

  it("lists active memories newest-first and excludes archived", async () => {
    const repo = new AgentMemoryRepository(drizzle(env.REGISTRY_DB, { schema }));

    const first = await repo.create({
      workspaceId: "workspace-memory-a",
      agentId: "agent-memory-a",
      content: "First fact",
    });
    const second = await repo.create({
      workspaceId: "workspace-memory-a",
      agentId: "agent-memory-a",
      content: "Second fact",
    });
    await repo.archive({
      workspaceId: "workspace-memory-a",
      agentId: "agent-memory-a",
      id: first.id,
    });

    await expect(
      repo.listActive({ workspaceId: "workspace-memory-a", agentId: "agent-memory-a" }),
    ).resolves.toMatchObject([{ id: second.id }]);
    await expect(
      repo.listArchived({ workspaceId: "workspace-memory-a", agentId: "agent-memory-a" }),
    ).resolves.toMatchObject([{ id: first.id }]);
  });

  it("restores an archived memory", async () => {
    const repo = new AgentMemoryRepository(drizzle(env.REGISTRY_DB, { schema }));

    const memory = await repo.create({
      workspaceId: "workspace-memory-a",
      agentId: "agent-memory-a",
      content: "A fact",
    });
    await repo.archive({
      workspaceId: "workspace-memory-a",
      agentId: "agent-memory-a",
      id: memory.id,
    });

    const restored = await repo.restore({
      workspaceId: "workspace-memory-a",
      agentId: "agent-memory-a",
      id: memory.id,
    });
    expect(restored?.archivedAt).toBeNull();
    await expect(
      repo.listActive({ workspaceId: "workspace-memory-a", agentId: "agent-memory-a" }),
    ).resolves.toMatchObject([{ id: memory.id }]);
  });

  describe("resolveMemoryIndex", () => {
    it("hooks each memory and excludes archived ones", async () => {
      const repo = new AgentMemoryRepository(drizzle(env.REGISTRY_DB, { schema }));
      await repo.create({
        workspaceId: "workspace-memory-a",
        agentId: "agent-memory-a",
        sourceThreadId: "thread-memory-a",
        title: "Deploys",
        content: "Always squash before deploying.",
        kind: "preference",
      });
      const dropped = await repo.create({
        workspaceId: "workspace-memory-a",
        agentId: "agent-memory-a",
        sourceThreadId: "thread-memory-a",
        content: "Forgotten thing",
      });
      await repo.archive({
        workspaceId: "workspace-memory-a",
        agentId: "agent-memory-a",
        id: dropped.id,
      });

      const index = await resolveMemoryIndex({
        env,
        workspaceId: "workspace-memory-a",
        agentId: "agent-memory-a",
      });

      expect(index?.total).toBe(1);
      expect(index?.entries).toEqual([
        {
          id: expect.any(String),
          kind: "preference",
          hook: "Deploys — Always squash before deploying.",
        },
      ]);
    });

    // No memories must mean no index section at all, not an empty heading that
    // tells the model it has none (and costs tokens saying so).
    it("returns undefined for an agent with no memories", async () => {
      await expect(
        resolveMemoryIndex({ env, workspaceId: "workspace-memory-a", agentId: "agent-memory-b" }),
      ).resolves.toBeUndefined();
    });

    it("truncates a long memory into a one-line hook", async () => {
      const repo = new AgentMemoryRepository(drizzle(env.REGISTRY_DB, { schema }));
      await repo.create({
        workspaceId: "workspace-memory-a",
        agentId: "agent-memory-b",
        sourceThreadId: "thread-memory-b",
        title: "Long one",
        content: "word ".repeat(200),
      });

      const index = await resolveMemoryIndex({
        env,
        workspaceId: "workspace-memory-a",
        agentId: "agent-memory-b",
      });

      expect(index?.entries[0]?.hook.length).toBeLessThanOrEqual(110);
      expect(index?.entries[0]?.hook.endsWith("…")).toBe(true);
    });
  });
});
