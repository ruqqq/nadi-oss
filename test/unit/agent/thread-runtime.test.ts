import { describe, expect, it } from "vitest";
import {
  agentNameForThreadRuntime,
  agentRoutePrefixForThreadRuntime,
  normalizeThreadRuntime,
  parseThreadRuntimeDefault,
  type ThreadRuntime,
} from "../../../src/agent/thread-runtime";

describe("thread runtime helpers", () => {
  it("normalizes persisted runtime values", () => {
    expect(normalizeThreadRuntime("think")).toBe("think");
    expect(normalizeThreadRuntime("legacy")).toBe("legacy");
    expect(normalizeThreadRuntime(null)).toBe("legacy");
    expect(normalizeThreadRuntime("bad")).toBe("legacy");
  });

  it("always uses Think for new thread defaults", () => {
    expect(parseThreadRuntimeDefault({ THREAD_RUNTIME_DEFAULT: "think" })).toBe("think");
    expect(parseThreadRuntimeDefault({ THREAD_RUNTIME_DEFAULT: "legacy" })).toBe("think");
    expect(parseThreadRuntimeDefault({ THREAD_RUNTIME_DEFAULT: "bad" })).toBe("think");
    expect(parseThreadRuntimeDefault({})).toBe("think");
  });

  it("maps runtimes to agent names and route prefixes", () => {
    const cases: Array<[ThreadRuntime, string, string]> = [
      ["legacy", "thread-agent", "/agents/thread-agent"],
      ["think", "think-thread-agent", "/think-agents/think-thread-agent"],
    ];

    for (const [runtime, agentName, prefix] of cases) {
      expect(agentNameForThreadRuntime(runtime)).toBe(agentName);
      expect(agentRoutePrefixForThreadRuntime(runtime)).toBe(prefix);
    }
  });
});
