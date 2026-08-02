import { describe, expect, it } from "vitest";
import { mergeThinkToolsStrict, thinkRouteThreadId } from "../../../src/agent/think-compat";

describe("think compat helpers", () => {
  it("extracts a thread id from the Think spike route", () => {
    expect(thinkRouteThreadId("/think-agents/think-thread-agent/thread_123")).toBe("thread_123");
    expect(thinkRouteThreadId("/agents/thread-agent-v2/thread_123")).toBeNull();
  });

  it("throws on tool name collisions", () => {
    expect(() => mergeThinkToolsStrict([{ read: {} as never }, { read: {} as never }])).toThrow(
      /tool_name_collision:read/,
    );
  });

  it("merges unique tool sets in order", () => {
    const result = mergeThinkToolsStrict([{ a: {} as never }, { b: {} as never }]);
    expect(Object.keys(result)).toEqual(["a", "b"]);
  });
});
