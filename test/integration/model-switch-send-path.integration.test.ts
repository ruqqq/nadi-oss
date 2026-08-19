import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { ThinkThreadAgent } from "../../src/agent/think-thread-agent";
import { readModelSwitchPart } from "../../src/agent/model-switch";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";

type Initializable = { __unsafe_ensureInitialized(): Promise<void> };

async function readThreadIndexRow(threadId: string) {
  return env.REGISTRY_DB.prepare("SELECT model_provider, model FROM thread_index WHERE id = ?")
    .bind(threadId)
    .first<{ model_provider: string | null; model: string | null }>();
}

/**
 * Poll `thread_index` INSIDE the same `runInDurableObject` callback so the
 * single-threaded DO's own event loop gets to actually advance the turn —
 * `_drainThinkSubmissions`/`drainQueuedUserMessagesForTest` claims a waiting
 * submission and starts its turn but does not block on it finishing, same as
 * production with no connected client. Mirrors
 * `queued-model-switch.integration.test.ts`'s `waitForModelCommit`.
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
 * The highest-value coverage this feature has: every OTHER test in this
 * suite (`model-switch-commit.integration.test.ts`,
 * `model-switch-commit.test.ts`) drives `commitPendingModelSwitch` by
 * invoking the prototype method DIRECTLY — exactly the pattern that let an
 * unregistered `callable()` ship to production invisible to every suite (see
 * `queued-model-switch.integration.test.ts`'s doc and the incident this
 * whole redesign traces back to). This file instead drives the REAL paths a
 * browser client uses:
 *
 *  - direct send: `agent.submitMessages(...)`, the same SDK entrypoint the
 *    WebSocket chat handler and `beginAutomatonRun` funnel into (see
 *    `@cloudflare/think`'s own doc: "Inject messages and trigger a model
 *    turn — without a WebSocket request... chaining from onChatResponse"),
 *    carrying the switch request as `UIMessage.metadata` exactly as
 *    `web/src/App.tsx`'s `handleSend` builds it;
 *  - queued send: `agent.submitQueuedUserMessage(...)`, exactly as
 *    `handleSend`'s queue branch calls it, with the switch request on the
 *    queued message's own `metadata` (no `setPendingModelSwitch` call
 *    anywhere in this file — that RPC no longer exists).
 *
 * Both drive the actual `_drainThinkSubmissions` → `beforeTurn` →
 * `commitPendingModelSwitch` pipeline, so a missing `callable()` on a
 * FUTURE client-facing RPC in this area, or a break in the wiring between
 * `App.tsx`'s metadata shape and the server's reader, would fail here even
 * though neither is invoked directly.
 */
describe("model switch send paths (end to end)", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  it("a direct send carrying a switch request commits it and marks the transcript", async () => {
    const { threadId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId: "thr_direct_send_e2e",
    });
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));

    const parts = await runInDurableObject(stub, async (agent: ThinkThreadAgent) => {
      await (agent as unknown as Initializable).__unsafe_ensureInitialized();
      // Exactly the message `App.tsx`'s `handleSend` builds for a direct
      // send: `sendMessage({ text, files, metadata })`, where `metadata` is
      // the client's local `pendingModel` pick, unvalidated until now.
      await agent.submitMessages([
        {
          id: "u1",
          role: "user",
          parts: [{ type: "text", text: "hello" }],
          metadata: { provider: "mock-tool-call", model: "mock-model-2" },
        },
      ]);
      await agent.drainQueuedUserMessagesForTest();
      await waitForModelCommit(threadId);
      return agent.messages.find((m) => m.id === "u1")?.parts;
    });

    const row = await readThreadIndexRow(threadId);
    expect(row?.model_provider).toBe("mock-tool-call");
    expect(row?.model).toBe("mock-model-2");

    // The server-written marker, not anything the client attached — the
    // client never constructs a `data-model-switch` part (see
    // `model-switch-parity.test.ts`'s "the client never writes the marker").
    expect(readModelSwitchPart(parts?.[0])).toEqual({
      from: { provider: "mock", model: "mock" },
      to: { provider: "mock-tool-call", model: "mock-model-2" },
    });
  });

  it("a rejected direct-send request leaves the turn running on the existing model", async () => {
    const { threadId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId: "thr_direct_send_rejected",
    });
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));

    await runInDurableObject(stub, async (agent: ThinkThreadAgent) => {
      await (agent as unknown as Initializable).__unsafe_ensureInitialized();
      await agent.submitMessages([
        {
          id: "u1",
          role: "user",
          parts: [{ type: "text", text: "hello" }],
          // A real provider (passes the structural parse in
          // `model-switch-request.ts`) this test workspace has no configured
          // settings for — `isUsableProviderForWorkspace` must refuse it,
          // proving this test reaches `resolveThreadModelSnapshotValue`
          // rather than degrading to "no request" earlier.
          metadata: { provider: "anthropic", model: "claude-opus-5" },
        },
      ]);
      await agent.drainQueuedUserMessagesForTest();
      // The turn still runs the user's message on the THREAD's existing
      // model — nothing aborts it. Give the (rejected, so never-committing)
      // turn a moment to actually execute before asserting nothing changed.
      await new Promise((resolve) => setTimeout(resolve, 25));
    });

    const row = await readThreadIndexRow(threadId);
    // Untouched: the seeded default from `seedRegistryThread` ("mock"/"mock")
    // was never overwritten, proving the rejection did not silently apply.
    expect(row?.model_provider === null || row?.model_provider === "mock").toBe(true);
  });

  it("a queued send carrying a switch request commits it and marks the transcript", async () => {
    const { threadId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId: "thr_queued_send_e2e",
    });
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));

    const parts = await runInDurableObject(stub, async (agent: ThinkThreadAgent) => {
      await (agent as unknown as Initializable).__unsafe_ensureInitialized();
      // Exactly the message `App.tsx`'s `handleSend` builds for its queue
      // branch: the switch request rides on the queued message's own
      // `metadata`, the ONE place `normalizeQueuedUserMessageInput` reads it
      // from now (see `queued-user-messages.ts`).
      await agent.submitQueuedUserMessage({
        message: {
          id: "q1",
          role: "user",
          parts: [{ type: "text", text: "hello, queued" }],
          metadata: { provider: "mock-tool-call", model: "mock-model-2" },
        },
      });
      await agent.drainQueuedUserMessagesForTest();
      await waitForModelCommit(threadId);
      return agent.messages.find((m) => m.id === "q1")?.parts;
    });

    const row = await readThreadIndexRow(threadId);
    expect(row?.model_provider).toBe("mock-tool-call");
    expect(row?.model).toBe("mock-model-2");

    expect(readModelSwitchPart(parts?.[0])).toEqual({
      from: { provider: "mock", model: "mock" },
      to: { provider: "mock-tool-call", model: "mock-model-2" },
    });
  });
});
