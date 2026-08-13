import { env, runInDurableObject } from "cloudflare:test";
import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import type { ThinkThreadAgent } from "../../src/agent/think-thread-agent";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";

// The one-shot wall clock delivered on a thread's first turn (see
// src/agent/thread-start-clock.ts). thread-start-clock.test.ts covers the body
// and the first-turn predicate as pure functions; what can only be wrong in the
// wiring is covered here: that beforeTurn puts the stamp in the turn's model
// input, persists it exactly once, and never stamps a second turn.

type InitializableAgent = ThinkThreadAgent & {
  __unsafe_ensureInitialized(): Promise<void>;
};

type ProbeableAgent = ThinkThreadAgent & {
  beforeTurnProbeForTest(messages?: ModelMessage[]): Promise<{ messageText?: string }>;
};

const user = (text: string): ModelMessage => ({ role: "user", content: text });
const assistant = (text: string): ModelMessage => ({ role: "assistant", content: text });

/** Matches the stamp's shape, not a frozen string: `2026-08-13T14:22:05Z (UTC)`. */
const CLOCK_STAMP = /The current date and time is \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z \(UTC\)/;

// Seeded per test, not in `beforeAll`: integration-fast's shared setup resets
// the registry between tests and would wipe a suite-level seed out from under
// these (see the comment on `integration-grouped` in vitest.config.ts).
async function seed(threadId: string) {
  await applyRegistryTestSchema(env.REGISTRY_DB);
  await seedRegistryThread(env.REGISTRY_DB, {
    workspaceId: `workspace-${threadId}`,
    agentId: `agent-${threadId}`,
    threadId,
    // Titled, so the auto-namer stays out of this test.
    title: "Seeded",
    titleSet: true,
    runtime: "think",
    provider: "mock",
    model: "mock",
  });
}

describe("thread-start clock reminder (beforeTurn, real DO)", () => {
  it("stamps the first turn's model input and persists it once", async () => {
    await seed("clock-first-turn");
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName("clock-first-turn"));
    const result = await runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
      await (instance as InitializableAgent).__unsafe_ensureInitialized();
      const beforeCount = instance.messages.length;
      const probe = await (instance as ProbeableAgent).beforeTurnProbeForTest([user("hello")]);
      return {
        messageText: probe.messageText ?? "",
        beforeCount,
        afterCount: instance.messages.length,
        persistedText: instance.messages
          .flatMap((m) => m.parts ?? [])
          .map((p) => ("text" in p ? (p as { text: string }).text : ""))
          .join("\n"),
      };
    });

    // (a) the model sees it this turn...
    expect(result.messageText).toMatch(CLOCK_STAMP);
    expect(result.messageText).toContain("does not advance");
    // ...at the tail, after the user's own message.
    expect(result.messageText.indexOf("hello")).toBeLessThan(
      result.messageText.search(CLOCK_STAMP),
    );

    // (b) and it is persisted exactly once, so turn two reads it from history.
    expect(result.afterCount).toBe(result.beforeCount + 1);
    expect(result.persistedText).toMatch(CLOCK_STAMP);
    expect(result.persistedText).toContain("<system-reminder>");
  });

  it("does not stamp a turn that already has an assistant reply", async () => {
    await seed("clock-later-turn");
    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName("clock-later-turn"));
    const result = await runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
      await (instance as InitializableAgent).__unsafe_ensureInitialized();
      const beforeCount = instance.messages.length;
      const probe = await (instance as ProbeableAgent).beforeTurnProbeForTest([
        user("hello"),
        assistant("hi"),
        user("what time is it?"),
      ]);
      return {
        messageText: probe.messageText ?? "",
        beforeCount,
        afterCount: instance.messages.length,
      };
    });

    expect(result.messageText).not.toMatch(CLOCK_STAMP);
    expect(result.afterCount).toBe(result.beforeCount);
  });
});
