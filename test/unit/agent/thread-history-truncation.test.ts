import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { resolveContextBudget } from "../../../src/agent/context-budget";
import { estimateTruncatedThreadTokens } from "../../../src/agent/thread-history-truncation";

function toolMsg(id: string, output: string): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [
      {
        type: "tool-exec",
        toolCallId: `call-${id}`,
        state: "output-available",
        input: {},
        output,
      } as unknown as UIMessage["parts"][number],
    ],
  };
}

function textMsg(id: string, role: "user" | "assistant", text: string): UIMessage {
  return { id, role, parts: [{ type: "text", text }] };
}

// A short recent tail so the interesting message is "aged" (outside keepRecent).
function recentFiller(): UIMessage[] {
  return Array.from({ length: 6 }, (_, i) => textMsg(`r${i}`, "assistant", "ok"));
}

describe("estimateTruncatedThreadTokens", () => {
  it("counts a large aged tool output at its truncated size, not its full size", () => {
    const budget = resolveContextBudget(200_000);
    // The budget's keepRecent (protected tail) is wider than the SDK default, so
    // the filler must outnumber it for t1 to actually age out of the window.
    const filler = Array.from({ length: budget.keepRecent + 4 }, (_, i) =>
      textMsg(`r${i}`, "assistant", "ok"),
    );
    const messages = [textMsg("u1", "user", "hi"), toolMsg("t1", "X".repeat(200_000)), ...filler];

    const tokens = estimateTruncatedThreadTokens({ messages, systemPrompt: "", budget });

    // Full untruncated count would be ~50k tokens (200k chars / 4); truncated to
    // the budget's maxToolOutputChars is far smaller.
    expect(tokens).toBeLessThan(budget.maxToolOutputChars / 2);
  });

  it("includes the system prompt in the estimate", () => {
    const messages = [textMsg("u1", "user", "hi"), ...recentFiller()];

    const withPrompt = estimateTruncatedThreadTokens({
      messages,
      systemPrompt: "word ".repeat(4_000),
      budget: resolveContextBudget(200_000),
    });
    const without = estimateTruncatedThreadTokens({
      messages,
      systemPrompt: "",
      budget: resolveContextBudget(200_000),
    });

    expect(withPrompt).toBeGreaterThan(without + 1_000);
  });

  it("counts the transcript at the budget's truncation, not the SDK's", () => {
    const big = "y".repeat(9_000);
    const messages = Array.from({ length: 10 }, (_, i) => ({
      id: `m${i}`,
      role: "assistant",
      parts: [
        {
          type: "tool-probe",
          toolCallId: `m${i}`,
          state: "output-available",
          input: {},
          output: big,
        },
      ],
    })) as unknown as Parameters<typeof estimateTruncatedThreadTokens>[0]["messages"];

    const small = estimateTruncatedThreadTokens({
      messages,
      systemPrompt: "",
      budget: resolveContextBudget(32_000),
    });
    const large = estimateTruncatedThreadTokens({
      messages,
      systemPrompt: "",
      budget: resolveContextBudget(200_000),
    });

    // A larger window keeps more of each aged tool output, so it counts MORE tokens.
    expect(large).toBeGreaterThan(small);
  });
});
