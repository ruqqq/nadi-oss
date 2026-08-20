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

// A short recent tail so the interesting message sits outside the retained tail.
function recentFiller(): UIMessage[] {
  return Array.from({ length: 6 }, (_, i) => textMsg(`r${i}`, "assistant", "ok"));
}

describe("estimateTruncatedThreadTokens", () => {
  it("counts a large tool output at its bounded size, not its full size", () => {
    const budget = resolveContextBudget(200_000);
    const filler = Array.from({ length: 10 }, (_, i) => textMsg(`r${i}`, "assistant", "ok"));
    const messages = [textMsg("u1", "user", "hi"), toolMsg("t1", "X".repeat(200_000)), ...filler];

    const tokens = estimateTruncatedThreadTokens({ messages, systemPrompt: "", budget });

    // Full untruncated count would be ~50k tokens (200k chars / 4); bounded to
    // partHead + partTail it is a small fraction of that.
    expect(tokens).toBeLessThan((budget.partHeadChars + budget.partTailChars) / 2);
  });

  // The regression this rewrite exists for: bounding used to be gated on
  // recency (`keepRecent` 21), so a SHORT thread whose opening turn was huge
  // was measured — and sent — at full size.
  it("bounds a huge opening turn even when the thread is only three messages", () => {
    const budget = resolveContextBudget(272_000);
    const messages = [
      textMsg("u0", "user", "explain the PR"),
      toolMsg("t1", "X".repeat(300_000)),
      textMsg("u2", "user", "go on"),
    ];

    const tokens = estimateTruncatedThreadTokens({ messages, systemPrompt: "", budget });

    expect(tokens).toBeLessThan(5_000);
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

  it("counts the transcript at the budget's bounding, not the raw stored size", () => {
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

    // Deliberately window-INDEPENDENT: the part bound is a fixed 4,096 + 1,024
    // for every model, so the same transcript costs the same either way. It used
    // to scale with the window, which grew the permanent post-compaction floor
    // on exactly the large models that could least afford a bigger floor.
    expect(large).toBe(small);
    // Raw would be ~22.5k tokens (10 x 9,000 chars / 4).
    expect(large).toBeLessThan(20_000);
  });
});
