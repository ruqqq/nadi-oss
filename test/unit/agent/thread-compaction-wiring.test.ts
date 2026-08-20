import { describe, expect, it, vi } from "vitest";
import { createThreadCompaction } from "../../../src/agent/think-thread-agent";
import { resolveContextBudget } from "../../../src/agent/context-budget";
import type { SummarizeRequest } from "../../../src/agent/compaction";

/**
 * The construction site, not the algorithm.
 *
 * `compaction.test.ts` proves Nadi's compaction function shows tool outputs to
 * the summarizer; this proves the FACTORY the agent registers with `onCompaction`
 * produces such a function — including the "failed, not a no-op" outcome contract.
 *
 * It does NOT guard the call site: it invokes `createThreadCompaction` directly,
 * so swapping the SDK's `createCompactFunction` back into `configureSession`
 * would leave it green. The call-site guard is the end-to-end compaction test in
 * `test/integration/think-thread-agent.integration.test.ts` ("compacts a
 * tool-heavy thread: history shortens and the summary sees tool outputs"), which
 * drives a real compaction through the real Session and asserts the summarizer
 * never saw "[object Object]".
 */
const budget = resolveContextBudget(200_000);

/** Substantial messages: the protected tail is a TOKEN budget, so a transcript of
 * trivially small ones fits entirely inside it and has no middle to compact. */
function history(n: number, chars = 6_000) {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    parts: [{ type: "text", text: `message ${i} ${"x".repeat(chars)}` }],
  })) as unknown as { id: string; role: string; parts: Record<string, unknown>[] }[];
}

describe("createThreadCompaction (the function the agent registers with onCompaction)", () => {
  it("shows object-shaped tool outputs to the summarizer, never [object Object]", async () => {
    const summarize = vi.fn(async (_request: SummarizeRequest) => "## Topic\nok");
    const messages = history(60);
    // Index 12 is outside the protected head (3) and, at ~1.5k tokens/message,
    // far outside the token-budgeted tail.
    messages[12] = {
      id: "m12",
      role: "assistant",
      parts: [
        {
          type: "tool-read_file",
          toolCallId: "call-1",
          toolName: "read_file",
          state: "output-available",
          input: { path: "a.ts" },
          output: { file: "a.ts", lines: 12 },
        },
      ],
    };

    const compact = createThreadCompaction({
      budget,
      summarize,
      onOutcome: () => {},
    });
    const result = await compact(messages as never);

    expect(result).not.toBeNull();
    // The seam hands the span over as MESSAGES carrying real tool outputs, so
    // the SDK's String(output) -> "[object Object]" path cannot come back.
    const request = summarize.mock.calls[0]?.[0] as SummarizeRequest;
    const rendered = JSON.stringify(request.messages);
    expect(rendered).not.toContain("[object Object]");
    expect(rendered).toContain("a.ts");
    expect(rendered).toContain("read_file");
  });

  it("reports a summarizer failure as 'failed', not as a no-op", async () => {
    const outcomes: unknown[] = [];
    const compact = createThreadCompaction({
      budget,
      summarize: async () => {
        throw new Error("rate limited");
      },
      onOutcome: (o) => outcomes.push(o),
    });

    expect(await compact(history(60) as never)).toBeNull();
    expect(outcomes).toEqual([
      expect.objectContaining({ status: "failed", error: expect.stringContaining("rate limited") }),
    ]);
  });
});
