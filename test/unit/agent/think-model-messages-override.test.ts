import { describe, expect, it } from "vitest";
import { ThinkThreadAgent } from "../../../src/agent/think-thread-agent";
import { resolveContextBudget } from "../../../src/agent/context-budget";

/**
 * `_assembleModelMessages` is installed on `ThinkThreadAgent.prototype` via
 * `Object.defineProperty` (see think-thread-agent.ts) because TypeScript won't
 * let a class declaration override a base-class `private` member. That
 * installation bypasses the type system entirely: a typo'd key, a deleted
 * `defineProperty` call, or a future Think rename would all still compile and
 * still pass every other test, silently reverting the model to the SDK's
 * hardcoded 500-char tool-output truncation regardless of context window.
 *
 * This test calls the override THROUGH THE PROTOTYPE (no DO, no env, no real
 * Think instance) and asserts the window-scaled policy actually ran, not just
 * that some function exists.
 */
describe("ThinkThreadAgent._assembleModelMessages override", () => {
  it("applies Nadi's part bounding instead of the SDK's fixed 4-message/500-char cut", async () => {
    // Sized off the REAL budget, not the SDK defaults. For any window the part
    // bound is partHead 4_096 + marker + partTail 1_024, and the retained tail
    // is minTailMessages = 2. A fixture that only clears the SDK defaults
    // (keepRecent 4, maxToolOutputChars 500) cannot tell "the override ran"
    // from "it silently fell back to Think's own method".
    const bigOutput = "x".repeat(20_000);
    const history = Array.from({ length: 20 }, (_, i) => ({
      id: `m${i}`,
      role: "assistant",
      parts: [
        {
          type: "tool-probe",
          toolCallId: `m${i}`,
          state: "output-available",
          input: {},
          output: bigOutput,
        },
      ],
    }));

    const agent = Object.create(ThinkThreadAgent.prototype) as Record<string, unknown>;
    // `messages` is an accessor (getter-only) on the prototype chain, so a
    // plain assignment throws — shadow it with an own data property instead.
    Object.defineProperty(agent, "messages", { value: history, configurable: true });
    agent.currentContextBudget = async () => resolveContextBudget(200_000);
    agent._repairTranscriptForProvider = async (m: unknown) => m;
    agent._incompleteToolCallIds = () => [];
    agent._emit = () => {};
    // No DO storage on a duck-typed `this`; this thread never switched model.
    agent.currentModelSwitchOrigin = async () => null;

    const out = await (
      agent as {
        _assembleModelMessages(
          tools: unknown,
        ): Promise<Array<{ role: string; content: Array<{ output: unknown }> }>>;
      }
    )._assembleModelMessages({});

    // One tool-role model message per history entry, in order, so position i
    // in this filtered list corresponds to history index i.
    const toolMessages = out.filter((m) => m.role === "tool");
    const outputSize = (i: number) => JSON.stringify(toolMessages[i]?.content[0]?.output).length;

    // Message 0 is bounded: an order of magnitude above the SDK's fixed ~500
    // cut, and clearly below the untouched 20,000. A regression that always
    // returned 500 or 1 fails this bound.
    expect(outputSize(0)).toBeGreaterThan(4_000);
    expect(outputSize(0)).toBeLessThan(8_000);

    // Message 16 is what actually proves OUR options ran. Under the SDK default
    // `keepRecent` of 4 it sits inside the protected window and comes back at
    // full 20,000; under Nadi's `minTailMessages` of 2 it is outside the
    // retained tail and gets bounded. Message 0 is truncated under both
    // policies and cannot make that distinction.
    expect(outputSize(16)).toBeLessThan(8_000);

    // The last two messages ARE the retained tail, and each is under
    // `maxRetainedMessageChars`, so they are replayed verbatim.
    expect(outputSize(19)).toBeGreaterThan(18_000);
  });
});

/**
 * A compaction summary is a VIEW rendered from the compaction rows, never a stored
 * message. Think's client round-trip would persist it as a real one (see the
 * override's comment in think-thread-agent.ts), after which the model reads the
 * same summary twice, forever. This asserts the override drops it.
 */
describe("compaction overlays are never persisted", () => {
  it("drops a compaction_* message the client echoed back", async () => {
    const persisted: string[] = [];
    const agent = Object.create(ThinkThreadAgent.prototype) as Record<string, unknown>;
    Object.defineProperty(agent, "name", { value: "thread-x", configurable: true });
    // Stand in for the SDK's real persist, so we can see what would have been written.
    Object.getPrototypeOf(ThinkThreadAgent.prototype)._persistIncomingMessage = async (m: {
      id: string;
    }) => {
      persisted.push(m.id);
    };

    const persist = (
      agent as unknown as {
        _persistIncomingMessage(m: unknown, s: unknown): Promise<unknown>;
      }
    )._persistIncomingMessage.bind(agent);

    await persist({ id: "compaction_abc", role: "assistant" }, []);
    await persist({ id: "msg_real", role: "user" }, []);

    // The overlay must never reach storage; the real message must.
    expect(persisted).toEqual(["msg_real"]);
  });
});

/**
 * Assembly must REBUILD the segmentation marker from DO storage before it
 * sanitizes. Compaction archives whole spans of messages, and the marker rides
 * one of them: without the rebuild the sanitizer sees a marker-less transcript,
 * calls it one same-origin segment, and replays the pre-switch model's signed
 * reasoning at the post-switch model. `cross-model-reasoning-sanitize.test.ts`
 * proves the rebuild itself; this proves the override actually calls it.
 */
describe("assembly rebuilds a compacted-away model-switch marker", () => {
  it("drops pre-switch reasoning even though no marker survives in the transcript", async () => {
    const history = [
      {
        id: "m1",
        role: "assistant",
        parts: [
          {
            type: "reasoning",
            text: "thinking as claude",
            providerMetadata: { anthropic: { signature: "sig-abc" } },
          },
          { type: "text", text: "claude turn" },
        ],
      },
      // The compaction overlay that replaced the span the marker rode on.
      { id: "compaction_c1", role: "assistant", parts: [{ type: "text", text: "summary" }] },
      {
        id: "m50",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "thinking as gpt" },
          { type: "text", text: "gpt turn" },
        ],
      },
    ];

    const agent = Object.create(ThinkThreadAgent.prototype) as Record<string, unknown>;
    Object.defineProperty(agent, "messages", { value: history, configurable: true });
    agent.currentContextBudget = async () => resolveContextBudget(200_000);
    agent._repairTranscriptForProvider = async (m: unknown) => m;
    agent._incompleteToolCallIds = () => [];
    agent._emit = () => {};
    // No DO storage on a duck-typed `this`: the durable origin record the
    // restore reads is stubbed in directly.
    agent.currentModelSwitchOrigin = async () => ({
      from: { provider: "openrouter", model: "anthropic/claude-opus-5" },
      to: { provider: "openrouter", model: "openai/gpt-5" },
      // Archived with its message — the only surviving position is the summary.
      anchorMessageId: "m40",
    });

    const out = await (
      agent as {
        _assembleModelMessages(
          tools: unknown,
        ): Promise<Array<{ role: string; content: Array<{ type: string; text?: string }> }>>;
      }
    )._assembleModelMessages({});

    const kinds = out.map((m) => m.content.map((c) => c.type));
    // The pre-switch (Anthropic) turn keeps its text and loses its reasoning...
    expect(kinds[0]).toEqual(["text"]);
    // ...while the current model's own reasoning still ships.
    expect(kinds[2]).toContain("reasoning");
  });
});
