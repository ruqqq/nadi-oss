import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { applyRegistryTestSchema } from "./helpers/registry";
import { selectThreadSummariesForUser } from "../../src/http/thread-routes";
import { TurnUsageAccumulator, flushThreadUsage } from "../../src/agent/usage-recorder";
import type { Env } from "../../src/env";

const now = 1_800_000_000_000;

function db() {
  return drizzle(env.REGISTRY_DB, { schema });
}

async function clearRegistry() {
  const conn = db();
  await conn.delete(schema.threadTokenUsage);
  await conn.delete(schema.threadIndex);
  await conn.delete(schema.agents);
  await conn.delete(schema.workspaceMembers);
  await conn.delete(schema.workspaces);
  await conn.delete(schema.users);
}

let counter = 0;

/**
 * Seeds a user, a workspace they belong to, an agent, and a fresh (never-run)
 * thread, following the same setup convention as
 * test/integration/thread-list-visibility.test.ts. Each call gets unique ids
 * so the three `it`s in this file don't collide.
 */
async function setupThread() {
  counter += 1;
  const userId = `user-token-usage-${counter}`;
  const workspaceId = `workspace-token-usage-${counter}`;
  const agentId = `agent-token-usage-${counter}`;
  const threadId = `thr_token_usage_${counter}`;

  const conn = db();
  await conn.insert(schema.users).values({
    id: userId,
    email: `${userId}@example.com`,
    name: null,
    createdAt: new Date(now),
    emailVerified: true,
    image: null,
    updatedAt: new Date(now),
  });
  await conn.insert(schema.workspaces).values({
    id: workspaceId,
    name: workspaceId,
    createdAt: now,
  });
  await conn.insert(schema.workspaceMembers).values({
    workspaceId,
    userId,
    role: "owner",
    createdAt: now,
  });
  await conn.insert(schema.agents).values({
    id: agentId,
    workspaceId,
    name: "Default",
    systemPrompt: "You are Nadi.",
    provider: "mock",
    model: "mock",
    modelInputModalities: JSON.stringify(["text"]),
    createdAt: now,
  });
  await conn.insert(schema.threadIndex).values({
    id: threadId,
    workspaceId,
    agentId,
    title: "Test Thread",
    runtime: "think",
    source: "manual",
    lastMessagePreview: "",
    createdAt: now,
    updatedAt: now,
  });

  return { env: env as unknown as Env, userId, workspaceId, agentId, threadId };
}

describe("thread token usage ledger", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  beforeEach(async () => {
    await clearRegistry();
  });

  it("upsert INCREMENTS across turns rather than overwriting", async () => {
    const { env: e, threadId, workspaceId, agentId } = await setupThread();
    const key = { provider: "anthropic", model: "claude-sonnet-5", source: "chat" } as const;

    const turn1 = new TurnUsageAccumulator();
    turn1.add(key, { inputTokens: 1_000, outputTokens: 100 });
    turn1.recordContext("anthropic", { inputTokens: 1_000 }, 200_000);
    await flushThreadUsage(e, { threadId, workspaceId, agentId }, turn1);

    const turn2 = new TurnUsageAccumulator();
    turn2.add(key, { inputTokens: 2_000, outputTokens: 200 });
    turn2.recordContext("anthropic", { inputTokens: 3_000 }, 200_000);
    await flushThreadUsage(e, { threadId, workspaceId, agentId }, turn2);

    const rows = await db()
      .select()
      .from(schema.threadTokenUsage)
      .where(eq(schema.threadTokenUsage.threadId, threadId));

    expect(rows).toHaveLength(1);
    expect(rows[0]!.inputTokens).toBe(3_000); // summed, NOT overwritten to 2_000
    expect(rows[0]!.outputTokens).toBe(300);
    expect(rows[0]!.calls).toBe(2);
  });

  it("the gauge tracks the LAST turn, while the ledger only grows — the compaction case", async () => {
    const { env: e, threadId, workspaceId, agentId, userId } = await setupThread();
    const ids = { threadId, workspaceId, agentId };

    const big = new TurnUsageAccumulator();
    big.add(
      { provider: "anthropic", model: "claude-sonnet-5", source: "chat" },
      { inputTokens: 180_000 },
    );
    big.recordContext("anthropic", { inputTokens: 180_000 }, 200_000);
    await flushThreadUsage(e, ids, big);

    // The turn that compacted: it SPENT more, and its context SHRANK.
    const compacted = new TurnUsageAccumulator();
    compacted.add(
      { provider: "anthropic", model: "claude-sonnet-5", source: "chat" },
      { inputTokens: 40_000 },
    );
    compacted.add(
      { provider: "workers-ai", model: "@cf/zai-org/glm-5.2", source: "compaction" },
      { inputTokens: 170_000, outputTokens: 2_000 },
    );
    compacted.recordContext("anthropic", { inputTokens: 40_000 }, 200_000, 118_400);
    await flushThreadUsage(e, ids, compacted);

    const rows = await db()
      .select()
      .from(schema.threadTokenUsage)
      .where(eq(schema.threadTokenUsage.threadId, threadId));
    // Two rows: the thread's model, and the fallback that served the summary.
    expect(rows).toHaveLength(2);
    // The ledger only ever grows.
    const chat = rows.find((r) => r.source === "chat")!;
    expect(chat.inputTokens).toBe(220_000);

    // The gauge fell, at the same instant — read through the real read path.
    const summaries = await selectThreadSummariesForUser(e, userId);
    const thread = summaries.threads.find((t) => t.threadId === threadId)!;
    expect(thread.lastContextTokens).toBe(40_000);
    expect(thread.lastContextWindow).toBe(200_000);
    // The turn's REAL compaction trigger, persisted so the client warns against it
    // instead of re-deriving the budget formula (and drifting from it).
    expect(thread.lastCompactAfterTokens).toBe(118_400);
  });

  it("reports null — not zero — for a thread that has never run a turn", async () => {
    const { env: e, threadId, userId } = await setupThread();
    const summaries = await selectThreadSummariesForUser(e, userId);
    const thread = summaries.threads.find((t) => t.threadId === threadId)!;
    expect(thread.lastContextTokens).toBeNull();
    expect(thread.lastContextWindow).toBeNull();
    expect(thread.lastCompactAfterTokens).toBeNull();
  });
});
