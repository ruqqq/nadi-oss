import { describe, expect, it } from "vitest";
import { ThinkThreadAgent } from "../../../src/agent/think-thread-agent";

/**
 * `commitPendingModelSwitch` is a private method reading its request off
 * `this.messages` (see `model-switch-request.ts`'s `effectiveModelSwitchRequest`)
 * rather than any DO storage slot — picking a model is now pure client state
 * that rides on the message that commits it. This drives the real prototype
 * method over a narrow duck-typed `this` (no DO, no env, no registry) for the
 * two branches that return BEFORE touching the registry DB: nothing to
 * commit, and the incomplete-tool-call guard.
 *
 * Every branch that DOES reach the registry — `resolveThreadModelSnapshotValue`
 * (workspace/provider validation), the six-column `thread_index` write, the
 * `updatedAt` non-bump guarantee, same-model-tuple no-op, and the transcript
 * marker — needs a real registry DB and Durable Object, and is proven in
 * `test/integration/model-switch-commit.integration.test.ts` and
 * `test/integration/model-switch-send-path.integration.test.ts` instead.
 * `model-switch-request.test.ts` covers the pure request-parsing/last-item-
 * wins rule this method's first line depends on.
 */

function agent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const a = Object.create(ThinkThreadAgent.prototype) as Record<string, unknown>;
  Object.defineProperty(a, "name", { value: "thr_1", configurable: true });
  Object.defineProperty(a, "messages", { value: [], configurable: true });
  a.env = {};
  a._incompleteToolCallIds = () => [];
  Object.assign(a, overrides);
  return a;
}

async function commit(a: Record<string, unknown>) {
  return (
    ThinkThreadAgent.prototype as unknown as {
      commitPendingModelSwitch(): Promise<unknown>;
    }
  ).commitPendingModelSwitch.call(a);
}

describe("commitPendingModelSwitch", () => {
  it("is a no-op when the trailing messages carry no switch request", async () => {
    const a = agent();
    Object.defineProperty(a, "messages", {
      value: [{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }],
      configurable: true,
    });

    await expect(commit(a)).resolves.toBeNull();
  });

  it("is a no-op on an empty transcript", async () => {
    await expect(commit(agent())).resolves.toBeNull();
  });

  it("is a no-op when the trailing user message's metadata is malformed", async () => {
    const a = agent();
    Object.defineProperty(a, "messages", {
      value: [
        {
          id: "u1",
          role: "user",
          parts: [{ type: "text", text: "hi" }],
          metadata: { provider: "not-a-real-provider", model: "x" },
        },
      ],
      configurable: true,
    });

    await expect(commit(a)).resolves.toBeNull();
  });

  it("defers and leaves the switch parked when an incomplete tool call survives", async () => {
    // A live tool call (input-available, no settled result) on an earlier
    // assistant message, with a fresh user message (carrying the request)
    // appended after it — exactly the shape that would let a foreign
    // thinking block get sanitized off the front of a tool_use turn.
    const messages = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-read_file",
            toolCallId: "call_1",
            state: "input-available",
            input: { path: "src/index.ts" },
          },
        ],
      },
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "keep going" }],
        metadata: { provider: "mock-tool-call", model: "mock-model-2" },
      },
    ];
    let resolveCalled = 0;
    const a = agent({
      // Real `_incompleteToolCallIds` (installed on Think's prototype) reads
      // `state`/`toolCallId` off UIMessage parts exactly like this — see
      // `think-model-messages-override.test.ts` for the same stub-vs-real
      // split. Stubbed directly here (rather than relying on the real
      // implementation) because reaching it requires no other Think setup.
      _incompleteToolCallIds: (given: unknown[]) => (given === messages ? ["call_1"] : []),
      resolveRuntimeConfigForThink: async () => {
        resolveCalled += 1;
        return { modelConfig: { provider: "mock", model: "mock" } };
      },
    });
    Object.defineProperty(a, "messages", { value: messages, configurable: true });
    // Reaching the registry would throw against `env = {}`; that failure
    // would itself prove the guard didn't hold, so no separate spy is needed.

    await expect(commit(a)).resolves.toBeNull();
    // The guard returns before the runtime config (and therefore the
    // registry) is ever touched.
    expect(resolveCalled).toBe(0);
  });
});
