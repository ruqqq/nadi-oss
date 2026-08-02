import { describe, expect, it } from "vitest";
import { parseThreadAgentPath } from "../../../src/agent-routing/agent-path";

describe("parseThreadAgentPath", () => {
  it("extracts the thread id from the Agents SDK route", () => {
    expect(parseThreadAgentPath(new URL("https://nadi.test/agents/thread-agent/thr_123"))).toEqual({
      agentClass: "thread-agent",
      threadId: "thr_123",
    });
  });

  it("extracts the thread id from the Think spike route", () => {
    expect(
      parseThreadAgentPath(new URL("https://nadi.test/think-agents/think-thread-agent/thr_123")),
    ).toEqual({
      agentClass: "think-thread-agent",
      threadId: "thr_123",
    });
  });

  it("decodes encoded thread ids", () => {
    expect(
      parseThreadAgentPath(new URL("https://nadi.test/agents/thread-agent/thr_%E2%9C%93")),
    ).toEqual({
      agentClass: "thread-agent",
      threadId: "thr_✓",
    });
  });

  it("returns null for non-thread-agent paths", () => {
    expect(parseThreadAgentPath(new URL("https://nadi.test/api/auth/get-session"))).toBeNull();
    expect(parseThreadAgentPath(new URL("https://nadi.test/agents/other/thr_123"))).toBeNull();
    expect(parseThreadAgentPath(new URL("https://nadi.test/agents/thread-agent"))).toBeNull();
  });
});
