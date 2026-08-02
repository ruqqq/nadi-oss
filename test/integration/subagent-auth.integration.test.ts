import { describe, expect, it } from "vitest";
import { ThinkThreadAgent } from "../../src/agent/think-thread-agent";

function makeGate(owns: Set<string>) {
  // Build a partial instance exercising only onBeforeSubAgent + hasSubAgent.
  const inst = Object.create(ThinkThreadAgent.prototype) as ThinkThreadAgent & {
    hasSubAgent: (c: string, n: string) => boolean;
  };
  (inst as any).hasSubAgent = (_c: string, n: string) => owns.has(n);
  return inst;
}

describe("onBeforeSubAgent gate", () => {
  it("404s an unknown child run", async () => {
    const inst = makeGate(new Set(["sub_known"]));
    const res = await inst.onBeforeSubAgent(new Request("https://x/sub/SubAgent/sub_guess"), {
      className: "SubAgent",
      name: "sub_guess",
    });
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(404);
  });

  it("passes through an owned child run", async () => {
    const inst = makeGate(new Set(["sub_known"]));
    const res = await inst.onBeforeSubAgent(new Request("https://x/sub/SubAgent/sub_known"), {
      className: "SubAgent",
      name: "sub_known",
    });
    expect(res).toBeUndefined();
  });
});
