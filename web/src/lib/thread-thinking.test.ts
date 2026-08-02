import { describe, expect, it } from "vitest";
import { latestThreadThinking } from "./thread-thinking";

type Part = { type: string; text?: string; state?: string };
type Message = { id: string; parts: Part[] };

const reasoning = (text: string, state = "done"): Part => ({ type: "reasoning", text, state });
const text = (value: string): Part => ({ type: "text", text: value });
const tool = (): Part => ({ type: "tool-call" });

describe("latestThreadThinking", () => {
  it("returns only the latest reasoning part across the thread", () => {
    const messages: Message[] = [
      { id: "m1", parts: [reasoning("older"), tool()] },
      { id: "m2", parts: [text("answer"), reasoning("newer")] },
    ];

    expect(latestThreadThinking(messages)).toEqual({
      key: "m2-reasoning-1",
      text: "newer",
      state: "done",
    });
  });

  it("returns null when there is no reasoning", () => {
    expect(latestThreadThinking([{ id: "m1", parts: [text("answer"), tool()] }])).toBeNull();
  });
});
