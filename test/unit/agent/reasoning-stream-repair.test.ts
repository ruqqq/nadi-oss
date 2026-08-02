import type { TextStreamPart, ToolSet } from "ai";
import { describe, expect, it } from "vitest";
import { repairOrphanReasoningStream } from "../../../src/agent/reasoning-stream-repair";

type Part = TextStreamPart<ToolSet>;

async function repair(parts: Part[]): Promise<Part[]> {
  const stream = new ReadableStream<Part>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  }).pipeThrough(repairOrphanReasoningStream<ToolSet>()({ tools: {}, stopStream: () => {} }));

  const repaired: Part[] = [];
  for await (const part of stream) repaired.push(part);
  return repaired;
}

describe("repairOrphanReasoningStream", () => {
  it("passes ordered reasoning parts through unchanged", async () => {
    const parts: Part[] = [
      { type: "reasoning-start", id: "rs_1:0" },
      { type: "reasoning-delta", id: "rs_1:0", text: "thinking" },
      { type: "reasoning-end", id: "rs_1:0" },
    ];

    await expect(repair(parts)).resolves.toEqual(parts);
  });

  it("synthesizes a start before an orphan reasoning delta", async () => {
    await expect(
      repair([
        {
          type: "reasoning-delta",
          id: "rs_1:0",
          text: "thinking",
          providerMetadata: { openai: { itemId: "rs_1" } },
        },
      ]),
    ).resolves.toEqual([
      {
        type: "reasoning-start",
        id: "rs_1:0",
        providerMetadata: { openai: { itemId: "rs_1" } },
      },
      {
        type: "reasoning-delta",
        id: "rs_1:0",
        text: "thinking",
        providerMetadata: { openai: { itemId: "rs_1" } },
      },
    ]);
  });

  it("treats reasoning after finish-step as a new active part", async () => {
    await expect(
      repair([
        { type: "reasoning-start", id: "rs_1:0" },
        { type: "finish-step", response: {}, usage: {}, finishReason: "stop" } as Part,
        { type: "reasoning-delta", id: "rs_1:0", text: "later" },
      ]),
    ).resolves.toEqual([
      { type: "reasoning-start", id: "rs_1:0" },
      { type: "finish-step", response: {}, usage: {}, finishReason: "stop" },
      { type: "reasoning-start", id: "rs_1:0" },
      { type: "reasoning-delta", id: "rs_1:0", text: "later" },
    ]);
  });
});
