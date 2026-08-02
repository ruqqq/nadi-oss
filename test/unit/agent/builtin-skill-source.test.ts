import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/think", () => ({
  skills: {
    fromManifest: vi.fn(),
  },
}));

import { softwareEngineeringBody } from "../../../src/agent/skills/builtin-skill-source";

describe("softwareEngineeringBody", () => {
  it("keeps proactive subagent guidance when background work is enabled", () => {
    expect(softwareEngineeringBody(true)).toContain("Use subagents proactively");
  });

  it("replaces subagent and watcher guidance when background work is disabled", () => {
    const body = softwareEngineeringBody(false);

    expect(body).toContain("Subagents are unavailable in this deployment");
    expect(body).toContain("never backgrounded");
    expect(body).not.toContain("Use subagents proactively");
  });
});
