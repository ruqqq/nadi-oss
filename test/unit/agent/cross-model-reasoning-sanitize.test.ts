import { convertToModelMessages, type UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { modelSwitchPart } from "../../../src/agent/model-switch";
import { sanitizeCrossModelReasoning } from "../../../src/agent/cross-model-reasoning-sanitize";

const anthropicReasoning = {
  type: "reasoning" as const,
  text: "thinking as claude",
  providerMetadata: { anthropic: { signature: "sig-abc" } },
};

const openaiReasoning = {
  type: "reasoning" as const,
  text: "thinking as gpt",
  providerMetadata: { openai: { itemId: "rs_123" } },
};

function assistant(id: string, parts: UIMessage["parts"]): UIMessage {
  return { id, role: "assistant", parts } as UIMessage;
}

function user(id: string, parts: UIMessage["parts"]): UIMessage {
  return { id, role: "user", parts } as UIMessage;
}

const SWITCH = modelSwitchPart({
  from: { provider: "anthropic", model: "claude-opus-5" },
  to: { provider: "openai", model: "gpt-5" },
}) as unknown as UIMessage["parts"][number];

describe("sanitizeCrossModelReasoning", () => {
  it("keeps every reasoning part when the thread has never switched", () => {
    const messages = [
      user("u1", [{ type: "text", text: "hi" }]),
      assistant("a1", [anthropicReasoning, { type: "text", text: "hello" }]),
    ];
    expect(sanitizeCrossModelReasoning(messages)).toBe(messages);
  });

  it("drops reasoning produced before the switch", () => {
    const result = sanitizeCrossModelReasoning([
      assistant("a1", [anthropicReasoning, { type: "text", text: "old" }]),
      user("u2", [SWITCH, { type: "text", text: "now use gpt" }]),
      assistant("a2", [openaiReasoning, { type: "text", text: "new" }]),
    ]);
    expect(result[0]?.parts).toEqual([{ type: "text", text: "old" }]);
    expect(result[2]?.parts).toEqual([openaiReasoning, { type: "text", text: "new" }]);
  });

  it("keeps reasoning from an earlier segment with the SAME tuple (A -> B -> A)", () => {
    const back = modelSwitchPart({
      from: { provider: "openai", model: "gpt-5" },
      to: { provider: "anthropic", model: "claude-opus-5" },
    }) as unknown as UIMessage["parts"][number];

    const result = sanitizeCrossModelReasoning([
      assistant("a1", [anthropicReasoning]),
      user("u2", [SWITCH]),
      assistant("a2", [openaiReasoning]),
      user("u3", [back]),
      assistant("a3", [anthropicReasoning]),
    ]);
    expect(result[0]?.parts).toEqual([anthropicReasoning]);
    expect(result[2]?.parts).toEqual([]);
    expect(result[4]?.parts).toEqual([anthropicReasoning]);
  });

  it("drops reasoning on a model-only switch inside one provider", () => {
    const orSwitch = modelSwitchPart({
      from: { provider: "openrouter", model: "anthropic/claude-opus-5" },
      to: { provider: "openrouter", model: "openai/gpt-5" },
    }) as unknown as UIMessage["parts"][number];

    const orReasoning = {
      type: "reasoning" as const,
      text: "claude via openrouter",
      providerMetadata: {
        openrouter: {
          reasoning_details: [
            { type: "reasoning.text", format: "anthropic-claude-v1", signature: "sig-xyz" },
          ],
        },
      },
    };

    const result = sanitizeCrossModelReasoning([
      assistant("a1", [orReasoning]),
      user("u2", [orSwitch]),
      assistant("a2", [{ type: "text", text: "answer" }]),
    ]);
    expect(result[0]?.parts).toEqual([]);
  });

  it("is deterministic: the same transcript sanitizes identically twice", () => {
    const messages = [
      assistant("a1", [anthropicReasoning]),
      user("u2", [SWITCH]),
      assistant("a2", [openaiReasoning]),
    ];
    const once = JSON.stringify(sanitizeCrossModelReasoning(messages));
    const twice = JSON.stringify(sanitizeCrossModelReasoning(messages));
    expect(once).toBe(twice);
  });

  it("is prefix-stable: appending a turn does not change the earlier prefix", () => {
    const base = [
      assistant("a1", [anthropicReasoning]),
      user("u2", [SWITCH]),
      assistant("a2", [openaiReasoning]),
    ];
    const grown = [
      ...base,
      user("u3", [{ type: "text", text: "more" }]),
      assistant("a3", [openaiReasoning]),
    ];
    const prefixBefore = JSON.stringify(sanitizeCrossModelReasoning(base));
    const prefixAfter = JSON.stringify(sanitizeCrossModelReasoning(grown).slice(0, 3));
    expect(prefixAfter).toBe(prefixBefore);
  });

  it("never lets the marker reach the model", async () => {
    const modelMessages = await convertToModelMessages([
      user("u2", [SWITCH, { type: "text", text: "now use gpt" }]),
    ]);
    expect(JSON.stringify(modelMessages)).not.toContain("model-switch");
  });
});
