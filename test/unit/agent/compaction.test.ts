import { describe, expect, it, vi } from "vitest";
import {
  createNadiCompactFunction,
  serializeToolOutputForSummary,
} from "../../../src/agent/compaction";
import { resolveContextBudget } from "../../../src/agent/context-budget";

const budget = resolveContextBudget(200_000);

/**
 * Messages are deliberately substantial (~1.5k tokens each). The protected tail
 * is a TOKEN budget, so a transcript of trivially small messages fits entirely
 * inside it and correctly has nothing to compact — which is also why compaction
 * never fires on one in production (the trigger is 118k tokens).
 */
function history(n: number, chars = 6_000) {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    parts: [{ type: "text", text: `message ${i} ${"x".repeat(chars)}` }],
  })) as never;
}

describe("serializeToolOutputForSummary", () => {
  // THE bug: the SDK does String(output) -> "[object Object]" for every
  // object-shaped tool output, and Nadi's capToolOutput preserves object shape.
  it("renders an object tool output as JSON, never [object Object]", () => {
    const text = serializeToolOutputForSummary({ file: "a.ts", lines: 12 }, 500);
    expect(text).not.toContain("[object Object]");
    expect(text).toContain("a.ts");
    expect(text).toContain("12");
  });

  it("truncates to the cap", () => {
    const text = serializeToolOutputForSummary("q".repeat(5_000), 100);
    expect(text.slice(0, 100)).toBe("q".repeat(100));
    expect(text).toContain("truncated 5000 chars");
  });

  it("renders null/undefined as empty, not the string 'undefined'", () => {
    expect(serializeToolOutputForSummary(undefined, 500)).toBe("");
    expect(serializeToolOutputForSummary(null, 500)).toBe("");
  });
});

describe("createNadiCompactFunction", () => {
  it("summarizes the middle and reports 'shortened'", async () => {
    const outcomes: unknown[] = [];
    const compact = createNadiCompactFunction({
      budget,
      summarize: async () => "## Topic\nA summary.",
      onOutcome: (o) => outcomes.push(o),
    });

    const result = await compact(history(60));

    expect(result).not.toBeNull();
    expect(result?.summary).toContain("A summary.");
    expect(outcomes).toEqual([expect.objectContaining({ status: "shortened" })]);
  });

  // The same bug, seen end to end: the prompt the summarizer actually receives
  // must show the tool's real result, not "[object Object]".
  it("shows object-shaped tool outputs to the summarizer", async () => {
    const summarize = vi.fn(async (_prompt: string) => "ok");
    const messages = history(60) as unknown as {
      id: string;
      role: string;
      parts: Record<string, unknown>[];
    }[];
    messages[12] = {
      id: "m12",
      role: "assistant",
      parts: [
        {
          type: "tool-read_file",
          toolCallId: "call-1",
          toolName: "read_file",
          state: "output-available",
          input: { path: "src/agent/compaction.ts" },
          output: { content: "export const answer = 42;", truncated: false },
        },
      ],
    };

    const compact = createNadiCompactFunction({ budget, summarize, onOutcome: () => {} });
    await compact(messages as never);

    const prompt = summarize.mock.calls[0]?.[0] ?? "";
    expect(prompt).not.toContain("[object Object]");
    expect(prompt).toContain("read_file");
    expect(prompt).toContain("export const answer = 42;");
    expect(prompt).toContain("src/agent/compaction.ts");
  });

  it("reports 'noop' — not 'failed' — when there is nothing to compact", async () => {
    const outcomes: unknown[] = [];
    const compact = createNadiCompactFunction({
      budget,
      summarize: async () => "unused",
      onOutcome: (o) => outcomes.push(o),
    });

    const result = await compact(history(2));

    expect(result).toBeNull();
    expect(outcomes).toEqual([expect.objectContaining({ status: "noop" })]);
  });

  // Today a summarizer failure surfaces to the user as "Nothing to compact yet."
  it("reports 'failed' when the summarizer throws", async () => {
    const outcomes: unknown[] = [];
    const compact = createNadiCompactFunction({
      budget,
      summarize: async () => {
        throw new Error("rate limited");
      },
      onOutcome: (o) => outcomes.push(o),
    });

    const result = await compact(history(60));

    expect(result).toBeNull();
    expect(outcomes).toEqual([
      expect.objectContaining({ status: "failed", error: expect.stringContaining("rate limited") }),
    ]);
  });

  it("caps the summary budget it asks for", async () => {
    const summarize = vi.fn(async (_prompt: string) => "ok");
    const compact = createNadiCompactFunction({ budget, summarize, onOutcome: () => {} });

    // Big enough that the SDK's unbounded `contentTokens * 0.2` would ask for
    // far more than maxSummaryTokens — that is what makes this test red if the
    // clamp is removed.
    await compact(history(120, 8_000));

    const prompt = summarize.mock.calls[0]?.[0] ?? "";
    const asked = Number(/~(\d+) tokens/.exec(prompt)?.[1] ?? "0");
    expect(asked).toBeGreaterThan(0);
    expect(asked).toBeLessThanOrEqual(budget.maxSummaryTokens);
    // The unclamped ask here is well above the cap, so the clamp must be what
    // produced this number.
    expect(asked).toBe(budget.maxSummaryTokens);
  });
});

/**
 * Head selection. `protectHead = 3` protected three MESSAGES regardless of what
 * they held; on thr_ba1be632 the third was one assistant turn of 23 tool calls
 * — 96.7% of the thread, permanently uncompactable. All four surveyed harnesses
 * compact the head; buzz alone preserves the original task, bounded.
 */
describe("head selection", () => {
  const userMsg = (id: string, text: string) => ({
    id,
    role: "user" as const,
    parts: [{ type: "text", text }],
  });
  const bigAssistant = (id: string, calls: number) => ({
    id,
    role: "assistant" as const,
    parts: Array.from({ length: calls }, (_, i) => ({
      type: "tool-exec",
      toolName: "exec",
      toolCallId: `${id}-${i}`,
      state: "output-available",
      input: {},
      output: "x".repeat(13_000),
    })),
  });

  // The exact shape of thr_ba1be632.
  it("summarizes a huge opening assistant turn instead of protecting it", async () => {
    const messages = [
      userMsg("u0", "explain-diff for PR 1414"),
      userMsg("u1", "<system-reminder>clock</system-reminder>"),
      bigAssistant("a2", 23),
      userMsg("u3", `republish ${"x".repeat(6_000)}`),
      userMsg("u4", `again ${"x".repeat(6_000)}`),
      userMsg("u5", `and again ${"x".repeat(6_000)}`),
    ];
    const seen: string[] = [];
    const compact = createNadiCompactFunction({
      budget: resolveContextBudget(272_000),
      summarize: async (prompt) => {
        seen.push(prompt);
        return "SUMMARY";
      },
      onOutcome: () => {},
    });

    const result = await compact(messages as never);

    expect(result).not.toBeNull();
    expect(result!.fromMessageId).toBe("u1");
    // The summarizer must actually see the delegated turn's tool calls.
    expect(seen[0]).toContain("[Tool: exec]");
  });

  it("never summarizes the first user message", async () => {
    const messages = [
      userMsg("u0", "the original task"),
      bigAssistant("a1", 23),
      userMsg("u2", `next ${"x".repeat(6_000)}`),
      userMsg("u3", `next ${"x".repeat(6_000)}`),
    ];
    const compact = createNadiCompactFunction({
      budget: resolveContextBudget(272_000),
      summarize: async () => "SUMMARY",
      onOutcome: () => {},
    });

    const result = await compact(messages as never);

    expect(result).not.toBeNull();
    expect(result!.fromMessageId).not.toBe("u0");
    expect(result!.fromMessageId).toBe("a1");
  });
});
