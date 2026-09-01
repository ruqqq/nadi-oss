import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/think", () => ({
  skills: {
    fromManifest: vi.fn(),
  },
}));

import { softwareEngineeringBody } from "../../../src/agent/skills/builtin-skill-source";
import { composeSystemPrompt } from "../../../src/agent/system-prompt";

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

  /**
   * The skill body and the system prompt reach the model TOGETHER, and they
   * used to contradict each other: the prompt says the thread's worktree is
   * already on its own branch and to leave it alone, while this body said
   * "create a dedicated feature branch from the default branch before the first
   * edit". A model following the body runs `git checkout <default>` inside its
   * worktree and gets git's "already checked out at /workspace/repos/<name>",
   * with no context for the error and no instruction that covers it.
   *
   * Nothing typechecks two prose blocks against each other, so this asserts the
   * agreement directly.
   */
  it("agrees with the system prompt about branching in the thread's worktree", () => {
    const body = softwareEngineeringBody({ backgroundExec: true, subagents: true });
    const prompt = composeSystemPrompt({ systemPrompt: "You are Nadi.", sandboxAvailable: true });

    expect(prompt).toContain("do not create another branch to work on");
    expect(body).toContain("Do NOT create a feature branch");
    expect(body).toContain("worktree");
    // The instruction the two used to disagree on, gone from the body.
    expect(body).not.toContain("Create a dedicated feature branch");
    expect(body).not.toContain("never work directly on the default branch");
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
