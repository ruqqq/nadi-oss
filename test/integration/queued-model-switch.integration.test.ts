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

function userMessage(id: string, text: string) {
  return { id, role: "user" as const, parts: [{ type: "text" as const, text }] };
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
 * Real-DO, real-D1 coverage of task 7. `queued-model-switch.test.ts` (unit)
 * covers the pure parsing/degrading, the last-surviving-item rule, and —
 * over the fake `QueuedSubmissionPort` harness `queued-user-messages.test.ts`
 * already uses — the rule this task exists for: cancelling one item removes
 * only that item's switch. That harness is deliberately used for the
 * merge/cancel machinery instead of a real DO here: a real DO's automatic
 * submission drain can complete a waiting message's turn before the next one
 * is even queued (see `think-thread-agent.integration.test.ts`'s "timing
 * tolerant" merge test), which would make an assertion about which switch a
 * *merged* real batch ends up carrying flaky by construction.
 *
 * What THIS file proves instead — things only a real DO and a real registry
 * DB can show:
 *  - capturing at queue time actually empties the real `PENDING_MODEL_SWITCH`
 *    storage slot, not just a modelled one;
 *  - a later `setPendingModelSwitch` call genuinely does not reach back into
 *    an already-queued item's stored metadata;
 *  - `commitPendingModelSwitch`'s new `carriedQueuedModelSwitch` lookup (task
 *    7's wiring into `beforeTurn`) actually finds the running submission and
 *    writes ITS switch to `thread_index`, end to end, for the single-item
 *    case where no merge race is in play.
 */
describe("queued message model binding (integration)", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  it("queuing captures the pending switch and empties the thread slot", async () => {
    const { threadId } = await seedRegistryThread(env.REGISTRY_DB, { threadId: "thr_qms_capture" });
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));

    const result = await runInDurableObject(stub, async (agent: ThinkThreadAgent) => {
      await agent.setPendingModelSwitch({ provider: "mock-tool-call", model: "mock-model-2" });
      await agent.submitQueuedUserMessage({ message: userMessage("m1", "later") });
      const pendingAfter = await agent.getPendingModelSwitch();
      const listed = (await agent.listQueuedUserMessages()) as QueuedRow[];
      return { pendingAfter, listed };
    });

    expect(result.pendingAfter).toBeNull();
    const row = result.listed.find((r) => r.clientMessageId === "m1");
    expect(row?.model).toBe("mock-model-2");
  });

  it("a later picker change does not retro-edit an already-queued item", async () => {
    const { threadId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId: "thr_qms_no_retro",
    });
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));

    const listed = await runInDurableObject(stub, async (agent: ThinkThreadAgent) => {
      await agent.setPendingModelSwitch({ provider: "mock-tool-call", model: "mock-model-2" });
      await agent.submitQueuedUserMessage({ message: userMessage("m1", "later") });
      // Changing the picker again AFTER m1 is queued must not touch m1's
      // already-captured switch — it belongs to m1 alone.
      await agent.setPendingModelSwitch({ provider: "mock-tool-call", model: "mock-model-3" });
      return (await agent.listQueuedUserMessages()) as QueuedRow[];
    });

    const row = listed.find((r) => r.clientMessageId === "m1");
    expect(row?.model).toBe("mock-model-2");
  });

  it("a switch carried by the queued item commits when its turn actually runs", async () => {
    const { threadId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId: "thr_qms_commit_e2e",
    });
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));

    await runInDurableObject(stub, async (agent: ThinkThreadAgent) => {
      await (agent as DrainableAgent).__unsafe_ensureInitialized();
      await agent.setPendingModelSwitch({ provider: "mock-tool-call", model: "mock-model-2" });
      await agent.submitQueuedUserMessage({ message: userMessage("m1", "hello") });
      // The pending slot is already empty by the time the submission is
      // even created (see the "captures... and empties" test above), so any
      // later commit MUST be reading the switch off the running submission's
      // item, not off a thread-scoped value.
      await (agent as DrainableAgent).drainQueuedUserMessagesForTest();
      await waitForModelCommit(threadId);
    });

    // The seeded default is "mock"/"mock" (see `seedRegistryThread`), so this
    // assertion is non-vacuous: it can only pass if `commitPendingModelSwitch`
    // genuinely found and applied the switch carried by m1's submission.
    const row = await readThreadIndexRow(threadId);
    expect(row?.model_provider).toBe("mock-tool-call");
    expect(row?.model).toBe("mock-model-2");
  });
});
