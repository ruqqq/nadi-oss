import { describe, expect, it } from "vitest";
import { ThinkThreadAgent } from "../../../src/agent/think-thread-agent";

/**
 * `setPendingModelSwitch`/`getPendingModelSwitch`/`clearPendingModelSwitch`
 * are DO-storage-backed RPCs, same class as `getDraft`/`setDraft`. This drives
 * the real prototype methods over a narrow duck-typed `this` (no DO, no env,
 * no registry) — same style as `workbench-switch-commit-wiring.test.ts` and
 * `turn-usage-wiring.test.ts`. `resolveThreadModelSnapshotValue` itself is
 * proven in `test/unit/settings/thread-model-snapshot.test.ts`; this only
 * proves the RPCs call it and persist/read/clear its result correctly.
 *
 * Durability across a fresh instance reading the SAME storage needs a real DO
 * (`ctx.storage` here is a hand-rolled Map) — that behaviour is proven in
 * `test/integration/pending-model-switch.integration.test.ts` instead, the
 * same split `thread-draft.integration.test.ts` uses for the draft.
 */

/** In-memory stand-in for `DurableObjectStorage`, scoped to get/put/delete. */
function fakeStorage() {
  const store = new Map<string, unknown>();
  return {
    store,
    get: async <T>(key: string) => store.get(key) as T | undefined,
    put: async (key: string, value: unknown) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  };
}

function agent(storage: ReturnType<typeof fakeStorage>): Record<string, unknown> {
  const a = Object.create(ThinkThreadAgent.prototype) as Record<string, unknown>;
  a.ctx = { storage };
  a.env = {};
  a.assertThreadWritable = async () => {};
  a.resolveRuntimeConfigForThink = async () => ({
    workspaceId: "ws_1",
    modelConfig: {
      provider: "mock",
      model: "mock",
      modelInputModalities: ["text"],
      showReasoning: true,
      reasoningEffort: "medium",
      modelSupportsReasoning: null,
    },
  });
  // Real workspace-owner lookup needs a registry DB; unreachable from this
  // duck-typed `this`, so stub the source the RPC consumes it through.
  a.viewerEmailForModelSelection = async () => "owner@example.com";
  return a;
}

describe("pending model switch", () => {
  it("stores a validated selection and reads it back", async () => {
    const storage = fakeStorage();
    const a = agent(storage);

    const result = await (
      ThinkThreadAgent.prototype.setPendingModelSwitch as (input: {
        provider: string;
        model: string;
      }) => Promise<{ ok: boolean; value?: unknown; error?: string }>
    ).call(a, { provider: "mock-tool-call", model: "gpt-5" });

    expect(result.ok).toBe(true);
    const read = await (
      ThinkThreadAgent.prototype.getPendingModelSwitch as () => Promise<unknown>
    ).call(a);
    expect(read).toMatchObject({ provider: "mock-tool-call", model: "gpt-5" });
  });

  it("rejects a provider the workspace cannot use and stores nothing", async () => {
    const storage = fakeStorage();
    const a = agent(storage);

    const result = await (
      ThinkThreadAgent.prototype.setPendingModelSwitch as (input: {
        provider: string;
        model: string;
      }) => Promise<{ ok: boolean; error?: string }>
    ).call(a, { provider: "not-a-provider", model: "x" });

    expect(result.ok).toBe(false);
    expect(storage.store.size).toBe(0);
    const read = await (
      ThinkThreadAgent.prototype.getPendingModelSwitch as () => Promise<unknown>
    ).call(a);
    expect(read).toBeNull();
  });

  it("clears", async () => {
    const storage = fakeStorage();
    const a = agent(storage);

    await (
      ThinkThreadAgent.prototype.setPendingModelSwitch as (input: {
        provider: string;
        model: string;
      }) => Promise<unknown>
    ).call(a, { provider: "mock-tool-call", model: "gpt-5" });
    expect(storage.store.size).toBe(1);

    await (ThinkThreadAgent.prototype.clearPendingModelSwitch as () => Promise<void>).call(a);

    const read = await (
      ThinkThreadAgent.prototype.getPendingModelSwitch as () => Promise<unknown>
    ).call(a);
    expect(read).toBeNull();
  });
});
