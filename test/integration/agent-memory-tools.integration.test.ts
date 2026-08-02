import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMemoryTools } from "../../src/agent/memory-tools";
import { AgentMemoryRepository } from "../../src/db/repositories/agent-memories";
import * as schema from "../../src/db/schema";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";

type MemoryTools = ReturnType<typeof createMemoryTools>;

async function runTool<TInput>(tools: MemoryTools, name: keyof MemoryTools, input: TInput) {
  return (await tools[name]?.execute?.(input, {} as never)) as string;
}

describe("agent memory tools", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  beforeEach(async () => {
    const db = drizzle(env.REGISTRY_DB, { schema });
    await db.delete(schema.agentMemories);
    await db.delete(schema.threadIndex);
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-tool-a",
      agentId: "agent-tool-a",
      threadId: "thread-tool-a",
    });
    await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-tool-a",
      agentId: "agent-tool-b",
      threadId: "thread-tool-b",
    });
  });

  it("exposes the model-facing memory tool names", () => {
    expect(Object.keys(createMemoryTools({ env, threadId: "thread-tool-a" })).sort()).toEqual([
      "forget_memory",
      "remember",
      "search_memories",
      "update_memory",
    ]);
  });

  it("resolves the current thread to the owning agent for remember and search", async () => {
    const tools = createMemoryTools({ env, threadId: "thread-tool-a" });

    const remembered = await runTool(tools, "remember", {
      title: "Preferred stack",
      kind: "preference",
      content: "The user prefers Drizzle for registry database access.",
    });
    expect(remembered).toContain("remembered:");

    const sameAgent = await runTool(tools, "search_memories", { query: "Drizzle registry" });
    expect(sameAgent).toContain("Preferred stack");

    const otherAgent = await runTool(
      createMemoryTools({ env, threadId: "thread-tool-b" }),
      "search_memories",
      {
        query: "Drizzle registry",
      },
    );
    expect(otherAgent).not.toContain("Preferred stack");
    expect(otherAgent).toContain("no memories found");
  });

  it("updates and forgets only memories owned by the thread agent", async () => {
    const repo = new AgentMemoryRepository(drizzle(env.REGISTRY_DB, { schema }));
    const owned = await repo.create({
      workspaceId: "workspace-tool-a",
      agentId: "agent-tool-a",
      title: "Old preference",
      content: "Old preference content",
    });
    const other = await repo.create({
      workspaceId: "workspace-tool-a",
      agentId: "agent-tool-b",
      title: "Other preference",
      content: "Other preference content",
    });
    const tools = createMemoryTools({ env, threadId: "thread-tool-a" });

    await expect(
      runTool(tools, "update_memory", {
        id: owned.id,
        title: "Updated preference",
        content: "Updated preference content",
      }),
    ).resolves.toContain("updated:");
    await expect(
      runTool(tools, "update_memory", {
        id: other.id,
        content: "Cross-agent edit",
      }),
    ).resolves.toContain("not found");

    await expect(runTool(tools, "forget_memory", { id: owned.id })).resolves.toContain("forgot:");
    await expect(runTool(tools, "forget_memory", { id: other.id })).resolves.toContain("not found");
  });

  it("rejects secret-looking memory content and missing threads", async () => {
    const tools = createMemoryTools({ env, threadId: "thread-tool-a" });
    await expect(
      runTool(tools, "remember", { content: "api_key=abc123 should not be stored" }),
    ).resolves.toContain("error: refusing to store secret-looking content");

    const missing = createMemoryTools({ env, threadId: "missing-thread" });
    await expect(runTool(missing, "search_memories", { query: "anything" })).resolves.toBe(
      "error: thread missing-thread not found",
    );
  });
});
