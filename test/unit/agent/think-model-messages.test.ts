import { describe, expect, it } from "vitest";
import { truncateOlderMessages } from "agents/experimental/memory/utils";
import { resolveContextBudget, truncationOptionsFor } from "../../../src/agent/context-budget";

type Msg = Parameters<typeof truncateOlderMessages>[0][number];

function toolMessage(id: string, output: string): Msg {
  return {
    id,
    role: "assistant",
    parts: [
      {
        type: "tool-probe",
        toolCallId: id,
        state: "output-available",
        input: {},
        output,
      },
    ],
  } as unknown as Msg;
}

describe("window-scaled truncation", () => {
  it("keeps far more of an aged tool output on a large-window model than the SDK default", () => {
    const bigOutput = "x".repeat(9_000);
    // 10 messages so the early ones are outside keepRecent on any budget.
    const history = Array.from({ length: 10 }, (_, i) => toolMessage(`m${i}`, bigOutput));

    const sdkDefault = truncateOlderMessages(history);
    const windowed = truncateOlderMessages(
      history,
      truncationOptionsFor(resolveContextBudget(200_000)),
    );

    const outputOf = (msgs: Msg[], idx: number) =>
      String(((msgs[idx] as Msg).parts[0] as { output: unknown }).output);

    // SDK default cuts an aged tool output to ~500 chars regardless of window.
    expect(outputOf(sdkDefault, 0).length).toBeLessThan(600);
    // Ours gives a 200k-window model an order of magnitude more.
    expect(outputOf(windowed, 0).length).toBeGreaterThan(5_000);
  });
});
