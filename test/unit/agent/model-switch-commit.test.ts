import { describe, expect, it } from "vitest";
import { ThinkThreadAgent } from "../../../src/agent/think-thread-agent";

/**
 * `commitPendingModelSwitch` is a DO-storage-backed private method, same
 * class of seam as `onChatResponse`'s workbench-switch commit
 * (`workbench-switch-commit-wiring.test.ts`). This drives the real prototype
 * method over a narrow duck-typed `this` for the two branches that return
 * BEFORE touching the registry DB — nothing pending, and the incomplete-
 * tool-call guard — so no D1/DO is needed here.
 *
 * The branches that DO write to `thread_index` (six columns committed, the
 * `updatedAt` non-bump guarantee, and same-model-tuple clearing without a
 * write) need a real registry DB and are proven in
 * `test/integration/model-switch-commit.integration.test.ts` instead — same
 * split `pending-model-switch.test.ts` / `pending-model-switch.integration.test.ts`
 * uses for the RPCs this method consumes.
 */

function agent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const a = Object.create(ThinkThreadAgent.prototype) as Record<string, unknown>;
  Object.defineProperty(a, "name", { value: "thr_1", configurable: true });
  Object.defineProperty(a, "messages", { value: [], configurable: true });
  a.env = {};
  a.getPendingModelSwitch = async () => null;
  a.clearPendingModelSwitch = async () => {};
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
  it("is a no-op when nothing is pending", async () => {
    const a = agent();
    let clearCalled = false;
    a.clearPendingModelSwitch = async () => {
      clearCalled = true;
    };

    await expect(commit(a)).resolves.toBeNull();
    expect(clearCalled).toBe(false);
  });

  it("defers and leaves the switch parked when an incomplete tool call survives", async () => {
    // A live tool call (input-available, no settled result) on the last
    // assistant message — exactly the shape that would let a foreign
    // thinking block get sanitized off the front of a tool_use turn.
    const liveToolCall = [
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
    ];
    let clearCalled = false;
    const a = agent({
      getPendingModelSwitch: async () => ({
        provider: "openai",
        model: "gpt-5",
        modelInputModalities: ["text"],
        showReasoning: true,
        reasoningEffort: "medium",
        modelSupportsReasoning: true,
      }),
      clearPendingModelSwitch: async () => {
        clearCalled = true;
      },
      // Real `_incompleteToolCallIds` (installed on Think's prototype) reads
      // `state`/`toolCallId` off UIMessage parts exactly like this — see
      // `think-model-messages-override.test.ts` for the same stub-vs-real
      // split. Stubbed directly here (rather than relying on the real
      // implementation) because reaching it requires no other Think setup.
      _incompleteToolCallIds: (messages: unknown[]) =>
        messages === liveToolCall ? ["call_1"] : [],
    });
    Object.defineProperty(a, "messages", { value: liveToolCall, configurable: true });
    // Reaching the registry would throw against `env = {}`; that failure
    // would itself prove the guard didn't hold, so no separate spy is needed
    // on `resolveRuntimeConfigForThink`/`ThreadRepository`.

    await expect(commit(a)).resolves.toBeNull();
    expect(clearCalled).toBe(false);
  });
});
