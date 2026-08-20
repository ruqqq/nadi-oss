import { describe, expect, it } from "vitest";
import { createNadiCompactFunction } from "../../../src/agent/compaction";
import { resolveContextBudget } from "../../../src/agent/context-budget";

const budget = resolveContextBudget(272_000);

/** A thread well over the trigger: alternating turns each carrying a large
 *  tool output, so the middle is genuinely worth summarizing. */
function makeThread(n: number, chars = 20_000) {
  return Array.from({ length: n }, (_, i) =>
    i % 2 === 0
      ? {
          id: `m${i}`,
          role: "user",
          parts: [{ type: "text", text: `turn ${i} ${"u".repeat(chars)}` }],
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
              output: "x".repeat(chars),
            },
          ],
        },
  ) as never;
}

describe("runtime convergence", () => {
  // deepseek: "reject a summary that does not shrink its source".
  it("rejects a summary larger than the span it replaces", async () => {
    const outcomes: { status: string }[] = [];
    const compact = createNadiCompactFunction({
      budget,
      summarize: async () => "S".repeat(40_000_000),
      onOutcome: (o) => outcomes.push(o as { status: string }),
    });

    const result = await compact(makeThread(40));

    expect(result).toBeNull();
    expect(outcomes.at(-1)).toMatchObject({ status: "failed" });
  });

  it("retries once when the first summary does not shrink the span", async () => {
    const outcomes: { status: string }[] = [];
    let call = 0;
    const compact = createNadiCompactFunction({
      budget,
      summarize: async () => (call++ === 0 ? "S".repeat(40_000_000) : "a small summary"),
      onOutcome: (o) => outcomes.push(o as { status: string }),
    });

    const result = await compact(makeThread(40));

    expect(call).toBe(2);
    expect(outcomes.some((o) => o.status === "retried")).toBe(true);
    expect(result).not.toBeNull();
    expect(result!.summary).toContain("a small summary");
  });

  // The summary is a term in the post-compaction floor. A summarizer that
  // ignores the target must not be allowed to inflate the thing it shrinks.
  it("rejects a summary over the summary budget even when it shrinks the span", async () => {
    const outcomes: { status: string }[] = [];
    const oversized = "S".repeat((budget.maxSummaryTokens + 5_000) * 4);
    const compact = createNadiCompactFunction({
      budget,
      summarize: async () => oversized,
      onOutcome: (o) => outcomes.push(o as { status: string }),
    });

    const result = await compact(makeThread(200));

    expect(result).toBeNull();
    expect(outcomes.at(-1)).toMatchObject({ status: "failed" });
  });

  it("accepts a normal summary without retrying", async () => {
    const outcomes: { status: string }[] = [];
    let call = 0;
    const compact = createNadiCompactFunction({
      budget,
      summarize: async () => {
        call++;
        return "## Topic\nA perfectly ordinary summary.";
      },
      onOutcome: (o) => outcomes.push(o as { status: string }),
    });

    const result = await compact(makeThread(40));

    expect(call).toBe(1);
    expect(result).not.toBeNull();
    expect(outcomes.some((o) => o.status === "retried")).toBe(false);
    expect(outcomes.at(-1)).toMatchObject({ status: "shortened" });
  });
});
