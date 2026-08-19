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
  // `name` is a base-class getter backed by DO internals this duck-typed `this`
  // does not have; the rejection path logs the thread id, so define it the same
  // way `workbench-switch-commit-wiring.test.ts` does.
  Object.defineProperty(a, "name", { value: "thr_1", configurable: true });
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

  it("persists a supplied modelInputModalities instead of the thread's old one", async () => {
    const storage = fakeStorage();
    const a = agent(storage);

    // `agent()`'s stubbed runtime config carries `["text"]` — the OLD model's
    // modalities. Supplying a new list here proves the RPC now passes it
    // through to `resolveThreadModelSnapshotValue` rather than silently
    // keeping the old value, which is exactly the defect: switching to a
    // vision-capable model must not leave attachments gated to text-only.
    const result = await (
      ThinkThreadAgent.prototype.setPendingModelSwitch as (input: {
        provider: string;
        model: string;
        modelInputModalities?: string[];
      }) => Promise<{ ok: boolean; value?: unknown; error?: string }>
    ).call(a, {
      provider: "mock-tool-call",
      model: "gpt-5-vision",
      modelInputModalities: ["text", "image"],
    });

    expect(result).toMatchObject({
      ok: true,
      value: { modelInputModalities: ["text", "image"] },
    });
    const read = await (
      ThinkThreadAgent.prototype.getPendingModelSwitch as () => Promise<unknown>
    ).call(a);
    expect(read).toMatchObject({ modelInputModalities: ["text", "image"] });
  });

  it("inherits the thread's current modalities/reasoning when neither is supplied", async () => {
    const storage = fakeStorage();
    const a = agent(storage);

    const result = await (
      ThinkThreadAgent.prototype.setPendingModelSwitch as (input: {
        provider: string;
        model: string;
      }) => Promise<{ ok: boolean; value?: unknown; error?: string }>
    ).call(a, { provider: "mock-tool-call", model: "gpt-5" });

    expect(result).toMatchObject({
      ok: true,
      // Matches `agent()`'s stubbed runtime config exactly — today's
      // behaviour (inherit-from-thread) must survive the fix.
      value: { modelInputModalities: ["text"], modelSupportsReasoning: null },
    });
  });

  it("rejects an invalid modelInputModalities and stores nothing", async () => {
    const storage = fakeStorage();
    const a = agent(storage);

    const result = await (
      ThinkThreadAgent.prototype.setPendingModelSwitch as (input: {
        provider: string;
        model: string;
        modelInputModalities?: unknown;
      }) => Promise<{ ok: boolean; error?: string }>
    ).call(a, {
      provider: "mock-tool-call",
      model: "gpt-5",
      modelInputModalities: ["not-a-real-modality"],
    });

    expect(result).toMatchObject({ ok: false, error: "invalid_modalities" });
    expect(storage.store.size).toBe(0);
  });

  it("round-trips an explicit modelSupportsReasoning: false, distinct from unknown/null", async () => {
    const storage = fakeStorage();
    const a = agent(storage);

    const result = await (
      ThinkThreadAgent.prototype.setPendingModelSwitch as (input: {
        provider: string;
        model: string;
        modelSupportsReasoning?: boolean | null;
      }) => Promise<{ ok: boolean; value?: unknown; error?: string }>
    ).call(a, {
      provider: "mock-tool-call",
      model: "gpt-5-no-reasoning",
      modelSupportsReasoning: false,
    });

    // An explicit `false` must persist as `false`, not fall through to the
    // thread's `null` ("unknown") default — only an explicit `false`
    // withholds reasoning options at turn time.
    expect(result).toMatchObject({ ok: true, value: { modelSupportsReasoning: false } });
    const read = await (
      ThinkThreadAgent.prototype.getPendingModelSwitch as () => Promise<unknown>
    ).call(a);
    expect(read).toMatchObject({ modelSupportsReasoning: false });
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

/**
 * The methods above are reached from the browser over the agents-SDK socket,
 * which refuses anything not registered with `callable()` — `_isCallable` is a
 * WeakMap lookup keyed by the function itself, so a plain public method is NOT
 * enough. Every other test in this file (and the integration one) invokes the
 * prototype methods DIRECTLY, which bypasses that registry entirely, so none of
 * them can see a missing registration.
 *
 * That gap shipped: production logged `Method setPendingModelSwitch is not
 * callable` on the first real switch, with every suite green. This is the test
 * that fails when a client-reachable RPC is added and not registered.
 */
describe("client-callable registration", () => {
  const CLIENT_RPCS = [
    "setPendingModelSwitch",
    "getPendingModelSwitch",
    "clearPendingModelSwitch",
  ] as const;

  it.each(CLIENT_RPCS)("%s is registered as a client-callable RPC", (method) => {
    const probe = Object.create(ThinkThreadAgent.prototype) as {
      _isCallable(name: string): boolean;
    };
    expect(probe._isCallable(method)).toBe(true);
  });

  it("getDraft is registered, proving the probe detects registration", () => {
    const probe = Object.create(ThinkThreadAgent.prototype) as {
      _isCallable(name: string): boolean;
    };
    expect(probe._isCallable("getDraft")).toBe(true);
  });
});
