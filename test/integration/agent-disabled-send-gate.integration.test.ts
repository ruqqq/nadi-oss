import { env, runInDurableObject } from "cloudflare:test";
import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import type { ThinkThreadAgent } from "../../src/agent/think-thread-agent";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";

/**
 * Turning an agent off, or deleting it, must stop its LIVE threads.
 *
 * Task 6 closed routing a NEW thread onto a disabled agent. Running one was
 * still open: the thread kept accepting messages and silently lost every
 * `exec_*` tool, because the compute config bailed with `reason: "disabled"`
 * and its only consumer discards the reason. The model then read a setting the
 * user changed as a broken deployment.
 *
 * The gate is `beforeTurn` -> `assertThreadWritable`, which resolves the agent
 * row live — so a stale tab cannot get past it either.
 */

type InitializableAgent = ThinkThreadAgent & {
  __unsafe_ensureInitialized(): Promise<void>;
};

type ProbeableAgent = ThinkThreadAgent & {
  beforeTurnProbeForTest(messages?: ModelMessage[]): Promise<unknown>;
};

const user = (text: string): ModelMessage => ({ role: "user", content: text });

async function seed(threadId: string) {
  await applyRegistryTestSchema(env.REGISTRY_DB);
  return seedRegistryThread(env.REGISTRY_DB, {
    workspaceId: `workspace-${threadId}`,
    agentId: `agent-${threadId}`,
    threadId,
    title: "Seeded",
    titleSet: true,
    runtime: "think",
  });
}

async function runTurn(threadId: string): Promise<string | null> {
  const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));
  return runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
    await (instance as InitializableAgent).__unsafe_ensureInitialized();
    try {
      await (instance as ProbeableAgent).beforeTurnProbeForTest([user("hello")]);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });
}

describe("a turn on an unusable agent", () => {
  it("runs normally while the agent is enabled and undeleted", async () => {
    await seed("gate-usable");
    expect(await runTurn("gate-usable")).toBeNull();
  });

  it("is refused, in the user's words, once the agent is turned off", async () => {
    const { agentId } = await seed("gate-disabled");
    await env.REGISTRY_DB.prepare("UPDATE agents SET enabled = 0 WHERE id = ?").bind(agentId).run();

    expect(await runTurn("gate-disabled")).toBe(
      "This thread's agent is turned off. Turn it back on in Settings → Agents to keep working here.",
    );
  });

  it("is refused as read-only history once the agent is deleted", async () => {
    const { agentId } = await seed("gate-archived");
    await env.REGISTRY_DB.prepare("UPDATE agents SET archived_at = ? WHERE id = ?")
      .bind(1_800_000_000_000, agentId)
      .run();

    expect(await runTurn("gate-archived")).toBe(
      "This thread's agent was deleted, so the thread is kept as read-only history.",
    );
  });
});
