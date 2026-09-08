import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { ThinkThreadAgent } from "../../src/agent/think-thread-agent";
import { readTurnErrorPart } from "../../src/agent/turn-error";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";

type Initializable = { __unsafe_ensureInitialized(): Promise<void> };

/**
 * A queued send whose model call fails must leave the thread in a state the
 * user can read. The failure mode this guards is the silent one: the queued
 * submission goes terminal, the composer's queued row disappears, and the
 * transcript gains nothing — so the client shows a typing indicator forever
 * with no error anywhere. Observed on the celld beta, where the only
 * configured provider answered 401.
 */
describe("a submitted turn whose model call fails", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  it("surfaces the failure instead of stalling silently", async () => {
    const { threadId } = await seedRegistryThread(env.REGISTRY_DB, {
      threadId: "thr_submission_failure",
      provider: "mock-error",
      model: "mock-error",
    });
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));

    const observed = await runInDurableObject(stub, async (agent: ThinkThreadAgent) => {
      await (agent as unknown as Initializable).__unsafe_ensureInitialized();
      await agent.submitQueuedUserMessage({
        message: {
          id: "q-fail-1",
          role: "user",
          parts: [{ type: "text", text: "this turn will fail" }],
        },
      });
      await agent.drainQueuedUserMessagesForTest();

      // The drain claims the submission and starts its turn but does not block
      // on it finishing (same as production with no connected client), so poll
      // the DO's own event loop until the failure has landed rather than
      // guessing a tick count — under a loaded suite a fixed wait is a flake.
      for (let attempt = 0; attempt < 600; attempt += 1) {
        const settled = agent.messages.some((message) =>
          message.parts.some((part) => readTurnErrorPart(part) !== null),
        );
        if (settled) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      return {
        queued: await agent.listQueuedUserMessages(),
        messages: agent.messages.map((message) => ({
          id: message.id,
          role: message.role,
          parts: message.parts,
        })),
      };
    });

    // Nothing may still be waiting: a queued row the client renders forever is
    // the stall itself.
    const stillWaiting = observed.queued.filter(
      (row) => row.status === "pending" || row.status === "running",
    );
    expect(stillWaiting).toEqual([]);

    // The user's own message must be in the transcript...
    expect(observed.messages.some((message) => message.id === "q-fail-1")).toBe(true);

    // ...and the failure must be a durable part of the transcript, carrying the
    // provider's own wording — that is what a reload and a never-attached
    // client both read.
    const failure = observed.messages
      .flatMap((message) => message.parts)
      .map((part) => readTurnErrorPart(part))
      .find((data): data is NonNullable<typeof data> => data !== null);
    expect(failure?.message).toContain("Missing API key");
  });
});
