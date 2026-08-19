import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { ThinkThreadAgent } from "../../src/agent/think-thread-agent";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";

type QueuedRow = { clientMessageId: string; submissionId: string; model?: string };
type DrainableAgent = ThinkThreadAgent & {
  drainQueuedUserMessagesForTest(): Promise<void>;
  __unsafe_ensureInitialized(): Promise<void>;
};

async function readThreadIndexRow(threadId: string) {
  return env.REGISTRY_DB.prepare("SELECT model_provider, model FROM thread_index WHERE id = ?")
    .bind(threadId)
    .first<{ model_provider: string | null; model: string | null }>();
}

function userMessage(id: string, text: string, modelSwitch?: { provider: string; model: string }) {
  return {
    id,
    role: "user" as const,
    parts: [{ type: "text" as const, text }],
    ...(modelSwitch ? { metadata: modelSwitch } : {}),
  };
}

/**
 * `_drainThinkSubmissions` (Think's own drain hook, wrapped by
 * `drainQueuedUserMessagesForTest`) claims a waiting submission and starts its
 * turn, but — same as a real production turn with no connected client —
 * doesn't block on the turn finishing (inference is async: `model_switched`
 * in the log below fires well after `_drainThinkSubmissions` itself resolves).
 * Poll `thread_index` directly, inside the SAME `runInDurableObject` callback
 * (so the single-threaded DO's own event loop gets to actually advance the
 * turn), until the commit this test is proving has landed.
 */
async function waitForModelCommit(threadId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const row = await readThreadIndexRow(threadId);
    if (row?.model_provider != null) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`model switch for ${threadId} did not commit in time`);
}

/**
 * Real-DO, real-D1 coverage of the queued send path's model binding. A
 * switch no longer enters the queue through any server-side capture step —
 * the client asserts it directly on the queued message's own `metadata`
 * (see `queued-user-messages.ts`'s `normalizeQueuedUserMessageInput`), so
 * there is no `setPendingModelSwitch`/`getPendingModelSwitch` anywhere in
 * this file any more; those RPCs are gone. `queued-model-switch.test.ts`
 * (unit) covers the pure parsing/degrading and the last-surviving-item rule
 * over a fake `QueuedSubmissionPort`; the full send-path commit, with the
 * transcript marker, is proven end to end (both direct and queued) in
 * `model-switch-send-path.integration.test.ts` instead.
 *
 * What THIS file proves that only a real DO and a real registry DB can show:
 *  - `listQueuedUserMessages` surfaces the per-item switch it read off the
 *    message's metadata (the row the queued strip actually renders);
 *  - queuing a second message with a different (or no) switch does not
 *    retro-edit an already-queued item's own metadata — it can't, since the
 *    switch lives on the message itself rather than in any mutable slot;
 *  - the switch carried by a queued item commits to `thread_index`, end to
 *    end, when its turn actually runs.
 */
describe("queued message model binding (integration)", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  it("listQueuedUserMessages surfaces the switch read off the message's own metadata", async () => {
    const { threadId } = await seedRegistryThread(env.REGISTRY_DB, { threadId: "thr_qms_capture" });
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));

    const listed = await runInDurableObject(stub, async (agent: ThinkThreadAgent) => {
      await agent.submitQueuedUserMessage({
        message: userMessage("m1", "later", { provider: "mock-tool-call", model: "mock-model-2" }),
      });
      return (await agent.listQueuedUserMessages()) as QueuedRow[];
    });

    const row = listed.find((r) => r.clientMessageId === "m1");
    expect(row?.model).toBe("mock-model-2");
  });

  it("queuing a second message does not retro-edit an already-queued item's switch", async () => {
    const { threadId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId: "thr_qms_no_retro",
    });
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));

    const listed = await runInDurableObject(stub, async (agent: ThinkThreadAgent) => {
      await agent.submitQueuedUserMessage({
        message: userMessage("m1", "later", { provider: "mock-tool-call", model: "mock-model-2" }),
      });
      // A second message queued with a DIFFERENT switch must not touch m1's
      // already-sent metadata — it belongs to m1 alone.
      await agent.submitQueuedUserMessage({
        message: userMessage("m2", "then", { provider: "mock-tool-call", model: "mock-model-3" }),
      });
      return (await agent.listQueuedUserMessages()) as QueuedRow[];
    });

    const m1 = listed.find((r) => r.clientMessageId === "m1");
    const m2 = listed.find((r) => r.clientMessageId === "m2");
    expect(m1?.model).toBe("mock-model-2");
    expect(m2?.model).toBe("mock-model-3");
  });

  it("a switch carried by the queued item commits when its turn actually runs", async () => {
    const { threadId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId: "thr_qms_commit_e2e",
    });
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));

    await runInDurableObject(stub, async (agent: ThinkThreadAgent) => {
      await (agent as DrainableAgent).__unsafe_ensureInitialized();
      await agent.submitQueuedUserMessage({
        message: userMessage("m1", "hello", { provider: "mock-tool-call", model: "mock-model-2" }),
      });
      await (agent as DrainableAgent).drainQueuedUserMessagesForTest();
      await waitForModelCommit(threadId);
    });

    // The seeded default is "mock"/"mock" (see `seedRegistryThread`), so this
    // assertion is non-vacuous: it can only pass if `commitPendingModelSwitch`
    // genuinely found and applied the switch carried by m1's message.
    const row = await readThreadIndexRow(threadId);
    expect(row?.model_provider).toBe("mock-tool-call");
    expect(row?.model).toBe("mock-model-2");
  });
});
