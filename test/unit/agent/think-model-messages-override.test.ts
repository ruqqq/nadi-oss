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
  it("applies window-scaled truncation instead of the SDK's fixed 4-message/500-char cut", async () => {
    // For a 200k window: keepRecent = clamp(148_000 / 10_000, 4, 32) = 14;
    // maxToolOutputChars = clamp(592_000 * 0.02, 500, 20_000) = 11_840. Every
    // fixture number below is sized off those two real values, not the SDK's
    // defaults (keepRecent 4, maxToolOutputChars 500) — a fixture that only
    // clears the SDK defaults can't tell "the override ran" from "it silently
    // fell back to Think's own method".
    const bigOutput = "x".repeat(20_000); // > 11_840, so the real cap actually fires
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

    // Message 0 is outside `keepRecent` (14) under the real budget, so its
    // 20_000-char output gets cut to the window-scaled cap (11_840). This
    // distinguishes "the cap ran" (order of magnitude above the SDK's fixed
    // ~500-char cut, and clearly below the untouched 20_000) from a broken
    // `maxToolOutputChars` — e.g. a regression that always returned 500 or 1
    // would fail this bound even though `keepRecent` stayed correct.
    expect(outputSize(0)).toBeGreaterThan(9_000);
    expect(outputSize(0)).toBeLessThan(14_000);

    // Message 10 is inside `keepRecent` (14) under the real budget — untouched
    // — but would fall OUTSIDE the SDK default `keepRecent` (4) and get
    // truncated to the cap. This is what actually exercises `keepRecent`: the
    // message-0 check above is truncated either way (aged under both the real
    // and the SDK-default window) and can't tell a `keepRecent` regression
    // apart from correct behavior.
    expect(outputSize(10)).toBeGreaterThan(18_000);
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
