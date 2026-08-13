import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/think", () => ({
  skills: {
    fromManifest: vi.fn(),
  },
}));

import { softwareEngineeringBody } from "../../../src/agent/skills/builtin-skill-source";

describe("softwareEngineeringBody", () => {
  it("keeps proactive subagent guidance when both capabilities are enabled", () => {
    const body = softwareEngineeringBody({ backgroundExec: true, subagents: true });
    expect(body).toContain("Use subagents proactively");
    expect(body).not.toContain("never backgrounded");
  });

  it("replaces subagent and watcher guidance when both are disabled", () => {
    const body = softwareEngineeringBody({ backgroundExec: false, subagents: false });

    expect(body).toContain("Subagents are unavailable in this deployment");
    expect(body).toContain("never backgrounded");
    expect(body).not.toContain("Use subagents proactively");
  });

  it("follows each capability independently", () => {
    // The whole point of the split: a workspace with subagents but no
    // backgrounded exec must get the subagent playbook AND the truthful
    // "commands are never backgrounded" note. Reading one boolean for both made
    // one of those two statements a lie in this configuration.
    const subagentsOnly = softwareEngineeringBody({ backgroundExec: false, subagents: true });
    expect(subagentsOnly).toContain("Use subagents proactively");
    expect(subagentsOnly).toContain("never backgrounded");

    const execOnly = softwareEngineeringBody({ backgroundExec: true, subagents: false });
    expect(execOnly).toContain("Subagents are unavailable in this deployment");
    expect(execOnly).toContain("backgrounded; the harness attempts to attach a watcher");
  });
});
