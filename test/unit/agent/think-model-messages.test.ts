import { describe, expect, it } from "vitest";
import { truncateOlderMessages } from "agents/experimental/memory/utils";
import { boundingOptionsFor, resolveContextBudget } from "../../../src/agent/context-budget";
import { boundTranscript } from "../../../src/agent/transcript-bounding";

type Msg = Parameters<typeof truncateOlderMessages>[0][number];

function toolMessage(id: string, output: string): Msg {
  return {
    id,
    role: "assistant",
    parts: [{ type: "tool-probe", toolCallId: id, state: "output-available", input: {}, output }],
  } as unknown as Msg;
}

const outputOf = (msgs: readonly Msg[], idx: number) =>
  String(((msgs[idx] as Msg).parts[0] as { output: unknown }).output);

describe("transcript bounding vs the SDK default", () => {
  it("keeps far more of a tool output than the SDK's fixed 500 chars", () => {
    const history = Array.from({ length: 10 }, (_, i) => toolMessage(`m${i}`, "x".repeat(9_000)));

    const sdkDefault = truncateOlderMessages(history);
    const bounded = boundTranscript(history, boundingOptionsFor(resolveContextBudget(200_000)));

    expect(outputOf(sdkDefault, 0).length).toBeLessThan(600);
    expect(outputOf(bounded, 0).length).toBeGreaterThan(5_000);
  });

  // Deliberate change from the window-scaled cap this file used to assert. All
  // three comparable harnesses use a FIXED cap (opencode and pi 2,000 chars;
  // deepseek head 4,096 + tail 1,024) because a cap that grows with the window
  // grows the permanent post-compaction floor with it.
  it("uses the same bound on a small window as on a large one", () => {
    const history = Array.from({ length: 10 }, (_, i) => toolMessage(`m${i}`, "x".repeat(9_000)));
    const small = boundTranscript(history, boundingOptionsFor(resolveContextBudget(32_000)));
    const large = boundTranscript(history, boundingOptionsFor(resolveContextBudget(1_000_000)));
    expect(outputOf(small, 0).length).toBe(outputOf(large, 0).length);
  });

  // The regression that motivated the rewrite: the SDK's `keepRecent` exempts
  // the last N messages, so on a short thread a huge opening turn was sent in
  // full. Bounding is position-independent outside the retained tail.
  it("bounds the opening turn of a three-message thread, which keepRecent would exempt", () => {
    const history = [
      toolMessage("m0", "x".repeat(300_000)),
      toolMessage("m1", "ok"),
      toolMessage("m2", "ok"),
    ];

    expect(outputOf(truncateOlderMessages(history), 0).length).toBe(300_000);
    const bounded = boundTranscript(history, boundingOptionsFor(resolveContextBudget(272_000)));
    expect(outputOf(bounded, 0).length).toBeLessThan(6_000);
  });
});
