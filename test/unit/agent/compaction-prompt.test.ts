import { describe, expect, it } from "vitest";
import {
  buildCheckpointText,
  buildInstruction,
  createNadiCompactFunction,
} from "../../../src/agent/compaction";
import { resolveContextBudget } from "../../../src/agent/context-budget";

describe("summary template", () => {
  // buzz asks its summarizer for "one concrete next step". Without it the model
  // re-derives what it was doing, which is how work gets repeated.
  it("demands exactly one concrete next action", () => {
    const prompt = buildInstruction(null, 500);
    expect(prompt).toContain("## Next Action");
    expect(prompt).toContain("exactly one");
  });

  it("keeps the anti-invention instruction", () => {
    expect(buildInstruction(null, 500)).toContain("Do NOT invent file paths");
  });
});

describe("buildCheckpointText", () => {
  // deepseek's checkpoint preamble.
  it("tells the model to build on the checkpoint without restating it", () => {
    const text = buildCheckpointText("SUMMARY", "");
    expect(text).toContain("established background");
    expect(text).toContain("without acknowledging this checkpoint");
    expect(text).toContain("SUMMARY");
  });

  it("puts the computed continuity block above the prose summary", () => {
    const text = buildCheckpointText("SUMMARY", "## Work already done\n- Files read: /a");
    expect(text.indexOf("Work already done")).toBeLessThan(text.indexOf("SUMMARY"));
  });

  it("omits the block entirely when there is no continuity to report", () => {
    expect(buildCheckpointText("SUMMARY", "")).not.toContain("Work already done");
  });

  it("is idempotent — framing an already-framed checkpoint does not double the preamble", () => {
    const once = buildCheckpointText("SUMMARY", "");
    const twice = buildCheckpointText(once, "");
    expect(twice.split("established background")).toHaveLength(2);
  });
});

/**
 * The summarizer call used to be a bespoke rendered string, sharing no prefix
 * with the thread's own requests — a guaranteed prompt-cache miss on every
 * compaction, at ~196k of input. deepseek replays the conversation's own
 * messages and appends the instruction last, specifically to keep the prefix
 * warm.
 */
describe("summarizer request shape", () => {
  const budget = resolveContextBudget(272_000);

  const thread = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      i % 2 === 0
        ? {
            id: `m${i}`,
            role: "user",
            parts: [{ type: "text", text: `turn ${i} ${"u".repeat(20_000)}` }],
          }
        : {
            id: `m${i}`,
            role: "assistant",
            parts: [
              {
                type: "tool-exec",
                toolName: "exec",
                toolCallId: `m${i}`,
                state: "output-available",
                input: {},
                output: "x".repeat(20_000),
              },
            ],
          },
    ) as never;

  it("hands the summarizer the span as messages with the instruction separate", async () => {
    let seen: { messages: unknown[]; instruction: string } | null = null;
    const compact = createNadiCompactFunction({
      budget,
      summarize: async (request) => {
        seen = request as { messages: unknown[]; instruction: string };
        return "a small summary";
      },
      onOutcome: () => {},
    });

    await compact(thread(40));

    expect(seen).not.toBeNull();
    expect(Array.isArray(seen!.messages)).toBe(true);
    expect(seen!.instruction).toContain("## Next Action");
    // Real message objects, not a rendered string — that IS the cache argument.
    expect(typeof seen!.messages[0]).toBe("object");
    expect(seen!.messages[0]).toHaveProperty("parts");
  });

  // If the summarizer bounded differently from the model-facing assembly the
  // prefix would differ and the cache would miss anyway — the whole point lost.
  it("bounds those messages exactly as the assembly does, so the prefix matches", async () => {
    let seen: { messages: { parts: { output?: unknown }[] }[] } | null = null;
    const compact = createNadiCompactFunction({
      budget,
      summarize: async (request) => {
        seen = request as never;
        return "a small summary";
      },
      onOutcome: () => {},
    });

    await compact(thread(40));

    const output = seen!.messages.flatMap((m) => m.parts).find((p) => p.output !== undefined);
    expect(typeof output!.output).toBe("string");
    // partHeadChars 4096 + marker + partTailChars 1024 — the assembly's bound,
    // not a tighter summarizer-only one.
    expect((output!.output as string).length).toBeGreaterThan(5_000);
    expect((output!.output as string).length).toBeLessThan(6_000);
  });
});
