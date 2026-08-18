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
 *
 * Task 7 added a `listSubmissions` lookup (`carriedQueuedModelSwitch`) at the
 * TOP of `commitPendingModelSwitch`, ahead of everything asserted here —
 * stubbed to return no submissions so it falls straight through to the
 * thread-scoped `getPendingModelSwitch` path this file exercises, same as an
 * unqueued/direct turn (no batch found) in production.
 */

/** Minimal stand-in for `this.ctx.storage`: the commit path reads the
 *  queued-switch gate flag off it and writes the origin record to it. */
function fakeStorage(initial: Record<string, unknown> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    storage: {
      get: async (key: string) => map.get(key),
      put: async (key: string, value: unknown) => {
        map.set(key, value);
      },
      delete: async (key: string) => {
        map.delete(key);
      },
    },
  };
}

function agent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const a = Object.create(ThinkThreadAgent.prototype) as Record<string, unknown>;
  Object.defineProperty(a, "name", { value: "thr_1", configurable: true });
  Object.defineProperty(a, "messages", { value: [], configurable: true });
  a.env = {};
  a.ctx = { storage: fakeStorage().storage };
  a.getPendingModelSwitch = async () => null;
  a.clearPendingModelSwitch = async () => {};
  a._incompleteToolCallIds = () => [];
  a.listSubmissions = async () => [];
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

/**
 * The `undefined` vs `null` tri-state of `carriedQueuedModelSwitch` is what
 * makes a model switch bind to the queued item that carried it. `undefined`
 * means "no batch drove this turn" and only THAT falls back to the
 * thread-scoped slot; `null` means "a batch drove this turn and none of its
 * items carried a switch", which must apply nothing and clear the stray slot.
 *
 * Nothing pinned the difference: collapsing the two comparisons in
 * `commitPendingModelSwitch` to `carried != null` left every model-switch
 * suite green while making a queued message run on a model the user chose
 * AFTER queueing it — the exact bug per-item binding exists to prevent.
 */
describe("commitPendingModelSwitch tri-state", () => {
  const strayPending = {
    provider: "openai",
    model: "gpt-5",
    modelInputModalities: ["text"],
    showReasoning: true,
    reasoningEffort: "medium" as const,
    modelSupportsReasoning: true,
  };

  it("applies nothing and clears the slot when the running batch carries no switch", async () => {
    // m1 was queued with nothing pending; the picker was changed to gpt-5
    // afterwards, leaving a stray thread-scoped value. m1's turn is running
    // now (its message id is in `this.messages`, so the batch is "applied").
    const applied = [{ id: "c1", role: "user", parts: [{ type: "text", text: "m1" }] }];
    let clearCalled = 0;
    let resolveCalled = 0;
    const a = agent({
      getPendingModelSwitch: async () => strayPending,
      clearPendingModelSwitch: async () => {
        clearCalled += 1;
      },
      resolveRuntimeConfigForThink: async () => {
        resolveCalled += 1;
        return { modelConfig: { provider: "mock", model: "mock" } };
      },
      listSubmissions: async () => [
        {
          submissionId: "sub-0",
          status: "running",
          createdAt: 100,
          metadata: {
            nadiKind: "queued_user_message",
            items: [
              { clientMessageId: "c1", textPreview: "m1", attachmentCount: 0, attachments: [] },
            ],
            messages: applied,
          },
        },
      ],
    });
    Object.defineProperty(a, "messages", { value: applied, configurable: true });

    await expect(commit(a)).resolves.toBeNull();
    // The batch is authoritative even carrying nothing: the stray slot is
    // dropped, and the turn is NOT re-resolved to commit anything.
    expect(clearCalled).toBe(1);
    expect(resolveCalled).toBe(0);
  });

  it("falls back to the thread slot when NO batch drove the turn", async () => {
    // The mirror case, so the test above cannot be satisfied by a variant
    // that simply ignores the thread slot entirely.
    let resolveCalled = 0;
    const a = agent({
      getPendingModelSwitch: async () => strayPending,
      resolveRuntimeConfigForThink: async () => {
        resolveCalled += 1;
        return { modelConfig: { provider: "mock", model: "mock" } };
      },
      listSubmissions: async () => [],
    });

    await commit(a).catch(() => {});
    expect(resolveCalled).toBe(1);
  });
});

/**
 * `carriedQueuedModelSwitch` runs `listSubmissions({ limit: 50 })` plus a full
 * `this.messages` id scan. It sat unconditionally at the top of every turn of
 * every agent — subagent turns included — overwhelmingly to find nothing. The
 * gate is two DO storage reads: the thread-scoped slot, and a flag raised when
 * a queued item captures a switch (the only way a switch can exist that the
 * slot cannot see).
 */
describe("commitPendingModelSwitch queue-scan gate", () => {
  it("does not scan submissions when nothing is parked anywhere", async () => {
    let scans = 0;
    const a = agent({
      listSubmissions: async () => {
        scans += 1;
        return [];
      },
    });

    await expect(commit(a)).resolves.toBeNull();
    expect(scans).toBe(0);
  });

  it("scans when a queued item is known to carry a switch", async () => {
    let scans = 0;
    const { map, storage } = fakeStorage({ "modelSwitch:queued": true });
    const a = agent({
      ctx: { storage },
      listSubmissions: async () => {
        scans += 1;
        return [];
      },
    });

    await expect(commit(a)).resolves.toBeNull();
    expect(scans).toBe(1);
    // The flag was stale (no batch, nothing parked), so it is dropped rather
    // than left to force the scan on every subsequent turn forever.
    expect(map.has("modelSwitch:queued")).toBe(false);
  });
});
