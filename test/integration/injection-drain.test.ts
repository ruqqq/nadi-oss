import { env, runInDurableObject } from "cloudflare:test";
import type { ModelMessage, UIMessage } from "ai";
import { beforeAll, describe, expect, it } from "vitest";
import { InjectionBuffer } from "../../src/agent/injection-buffer";
import type { ThinkThreadAgent } from "../../src/agent/think-thread-agent";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";

// Covers the linchpin drain→persist→append contract exercised by
// `_drainInjectionsIntoTurn`/`beforeStep` (see think-thread-agent.ts): peek the
// durable buffer, persist via `addMessages` BEFORE deleting, then append the
// converted message to the returned step's messages (newest last). Previously
// only covered by a live smoke test.

type InitializableAgent = ThinkThreadAgent & {
  __unsafe_ensureInitialized(): Promise<void>;
};

function storageOf(agent: unknown): DurableObjectStorage {
  return (agent as { ctx: { storage: DurableObjectStorage } }).ctx.storage;
}

const msg = (id: string): UIMessage => ({ id, role: "user", parts: [{ type: "text", text: id }] });
const mm = (text: string): ModelMessage => ({ role: "user", content: text });

/** Text of a UIMessage's text parts (steered messages carry plain text). */
function uiTextOf(message: UIMessage | undefined): string {
  return (message?.parts ?? [])
    .map((p) => ("text" in p ? (p as { text: string }).text : ""))
    .join("");
}

/** Extract plain text regardless of whether `content` is a string or a parts array
 *  (convertToModelMessages produces the latter for a UIMessage's text part). */
function textOf(message: ModelMessage | undefined): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content.map((part) => ("text" in part ? part.text : "")).join("");
  }
  return "";
}

beforeAll(async () => {
  await applyRegistryTestSchema(env.REGISTRY_DB);
  await seedRegistryThread(env.REGISTRY_DB, {
    workspaceId: "workspace-think-injection-drain",
    agentId: "agent-think-injection-drain",
    threadId: "think-injection-drain",
    runtime: "think",
    provider: "mock",
    model: "mock",
  });
  await seedRegistryThread(env.REGISTRY_DB, {
    workspaceId: "workspace-think-steer-rpc",
    agentId: "agent-think-steer-rpc",
    threadId: "think-steer-rpc",
    runtime: "think",
    provider: "mock",
    model: "mock",
  });
});

describe("ThinkThreadAgent injection drain (beforeStep, real DO)", () => {
  it("drains the buffer, persists via addMessages BEFORE deleting, and appends the injected message last", async () => {
    const stub = env.THINK_THREAD_AGENT.get(
      env.THINK_THREAD_AGENT.idFromName("think-injection-drain"),
    );
    const result = await runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
      await (instance as InitializableAgent).__unsafe_ensureInitialized();

      // Enqueue directly into the durable buffer (bypassing deliverInjection's
      // routeInjection, which would fire-and-forget a `_kickInjectionTurn` and
      // race with the beforeStep call below since no turn is active in this
      // harness).
      const buffer = new InjectionBuffer(storageOf(instance));
      buffer.migrate();
      const enqueued = buffer.enqueue({
        dedupeKey: "watcher:proc-1:success",
        kind: "watcher-completion",
        message: msg("watcher-done"),
        now: Date.now(),
      });
      const bufferEmptyBefore = buffer.isEmpty();

      const beforeCount = instance.messages.length;
      // stepNumber 0 with currentTurnMaxSteps unset (no beforeTurn ran) falls
      // back to the default MAX_TOOL_STEPS, so this is far from the final
      // wind-down step — the only shaped return should be the injected messages.
      const stepConfig = await instance.beforeStep({
        stepNumber: 0,
        messages: [mm("in-flight tool output")],
      } as never);

      return {
        enqueued,
        bufferEmptyBefore,
        stepConfig: stepConfig as { messages: ModelMessage[] } | undefined,
        beforeCount,
        afterCount: instance.messages.length,
        persistedIds: instance.messages.map((m) => m.id),
        bufferEmptyAfter: buffer.isEmpty(),
      };
    });

    expect(result.enqueued).toBe(true);
    expect(result.bufferEmptyBefore).toBe(false);

    // (a) the returned step messages end with the injected message, appended
    // AFTER the in-flight event messages (newest last).
    expect(result.stepConfig).toBeDefined();
    const outMessages = result.stepConfig?.messages ?? [];
    expect(outMessages).toHaveLength(2);
    expect(textOf(outMessages[0])).toBe("in-flight tool output");
    expect(outMessages[1]?.role).toBe("user");
    expect(textOf(outMessages[1])).toBe("watcher-done");

    // (b) the injected message is now durably persisted (addMessages ran
    // before the buffer was drained).
    expect(result.afterCount).toBe(result.beforeCount + 1);
    expect(result.persistedIds).toContain("watcher-done");

    // (c) the buffer is empty AFTER the persist (drained).
    expect(result.bufferEmptyAfter).toBe(true);
  });
});

describe("ThinkThreadAgent steer RPCs (real DO)", () => {
  it("steers into the buffer, lists/drains to Sent, and cancels server-authoritatively", async () => {
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName("think-steer-rpc"));
    const r = await runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
      await (instance as InitializableAgent).__unsafe_ensureInitialized();
      // Pin the turn "active" so deliverInjection BUFFERS (the steer path) rather
      // than fire-and-forget kicking a turn that would drain mid-assertion.
      (instance as unknown as { _turnQueue: { isActive: boolean } })._turnQueue = {
        isActive: true,
      };

      // 1) steer → buffered; pendingSteerKeys reflects it; not yet in transcript.
      const steerReturn = await instance.steer("use the v2 endpoint", "steer-1");
      const pendingAfterSteer = await instance.pendingSteerKeys();
      // listPendingSteers returns text too (client refresh-survival rehydration).
      const listedAfterSteer = await instance.listPendingSteers();
      const inTranscriptBeforeDrain = instance.messages.some((m) => m.id === "steer-1");

      // 2) cancel while pending → server-confirmed success + restored text.
      const cancelPending = await instance.cancelSteer("steer-1");
      const pendingAfterCancel = await instance.pendingSteerKeys();

      // 3) steer two, drain via beforeStep → both persisted; pending empties (Sent).
      await instance.steer("first", "steer-a");
      await instance.steer("second", "steer-b");
      const pendingTwo = await instance.pendingSteerKeys();
      await instance.beforeStep({ stepNumber: 0, messages: [] } as never);
      const pendingAfterDrain = await instance.pendingSteerKeys();
      const steeredA = instance.messages.find((m) => m.id === "steer-a");
      const bothInTranscript =
        instance.messages.some((m) => m.id === "steer-a") &&
        instance.messages.some((m) => m.id === "steer-b");

      // 4) cancel after drain → too-late.
      const cancelTooLate = await instance.cancelSteer("steer-a");

      // 5) validation.
      let emptyTextThrew = false;
      try {
        await instance.steer("   ", "x");
      } catch {
        emptyTextThrew = true;
      }
      let emptyIdThrew = false;
      try {
        await instance.steer("hi", "");
      } catch {
        emptyIdThrew = true;
      }

      const listedAfterDrain = await instance.listPendingSteers();

      return {
        steerReturn,
        pendingAfterSteer,
        listedAfterSteer,
        listedAfterDrain,
        inTranscriptBeforeDrain,
        cancelPending,
        pendingAfterCancel,
        pendingTwo,
        pendingAfterDrain,
        bothInTranscript,
        steeredRole: steeredA?.role,
        steeredKind: (steeredA?.metadata as { nadiKind?: string } | undefined)?.nadiKind,
        steeredText: uiTextOf(steeredA),
        cancelTooLate,
        emptyTextThrew,
        emptyIdThrew,
      };
    });

    // steer buffers + lists (Steering)
    expect(r.steerReturn).toEqual(["steer-1"]);
    expect(r.pendingAfterSteer).toEqual(["steer-1"]);
    // listPendingSteers carries text so the client can rehydrate chips on reload
    expect(r.listedAfterSteer).toEqual([
      { clientMessageId: "steer-1", text: "use the v2 endpoint" },
    ]);
    expect(r.listedAfterDrain).toEqual([]);
    expect(r.inTranscriptBeforeDrain).toBe(false);
    // cancel while pending wins, restores text
    expect(r.cancelPending).toEqual({ cancelled: true, restoredText: "use the v2 endpoint" });
    expect(r.pendingAfterCancel).toEqual([]);
    // multiple steers batch, then drain together (Sent)
    expect(r.pendingTwo).toEqual(["steer-a", "steer-b"]);
    expect(r.pendingAfterDrain).toEqual([]);
    expect(r.bothInTranscript).toBe(true);
    // the persisted steer is a real user message tagged "steered"
    expect(r.steeredRole).toBe("user");
    expect(r.steeredKind).toBe("steered");
    expect(r.steeredText).toBe("first");
    // cancel after drain is honestly refused (too-late race)
    expect(r.cancelTooLate).toEqual({ cancelled: false });
    // validation
    expect(r.emptyTextThrew).toBe(true);
    expect(r.emptyIdThrew).toBe(true);
  });
});
