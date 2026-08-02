import { tool } from "ai";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { decideToolPolicy, wrapToolsWithPolicy } from "../../../src/mcp/policy";

describe("decideToolPolicy", () => {
  it("defaults to approval_required when no policy provided", () => {
    expect(decideToolPolicy({})).toBe("approval_required");
  });

  it("returns toolPolicy when provided", () => {
    expect(decideToolPolicy({ toolPolicy: "auto_allow" })).toBe("auto_allow");
    expect(decideToolPolicy({ toolPolicy: "deny" })).toBe("deny");
    expect(decideToolPolicy({ toolPolicy: "approval_required" })).toBe("approval_required");
  });

  it("uses defaultPolicy as fallback when toolPolicy is not provided", () => {
    expect(decideToolPolicy({ defaultPolicy: "auto_allow" })).toBe("auto_allow");
    expect(decideToolPolicy({ defaultPolicy: "deny" })).toBe("deny");
  });

  it("toolPolicy overrides defaultPolicy", () => {
    expect(decideToolPolicy({ toolPolicy: "auto_allow", defaultPolicy: "deny" })).toBe(
      "auto_allow",
    );
  });
});

describe("wrapToolsWithPolicy", () => {
  const makeTool = (name: string) => {
    const executeFn = vi.fn().mockResolvedValue(`result:${name}`);
    return tool({
      description: `Tool ${name}`,
      inputSchema: z.object({ x: z.string() }),
      execute: executeFn,
    });
  };

  it("omits deny tools", () => {
    const tools = {
      allowed: makeTool("allowed"),
      blocked: makeTool("blocked"),
    };
    const wrapped = wrapToolsWithPolicy(tools, (name) =>
      name === "blocked" ? "deny" : "auto_allow",
    );
    expect(Object.keys(wrapped)).toContain("allowed");
    expect(Object.keys(wrapped)).not.toContain("blocked");
  });

  it("sets needsApproval: true for approval_required tools", () => {
    const tools = { sensitive: makeTool("sensitive") };
    const wrapped = wrapToolsWithPolicy(tools, () => "approval_required");
    expect(wrapped["sensitive"]?.needsApproval).toBe(true);
  });

  it("sets needsApproval: false for auto_allow tools", () => {
    const tools = { safe: makeTool("safe") };
    const wrapped = wrapToolsWithPolicy(tools, () => "auto_allow");
    expect(wrapped["safe"]?.needsApproval).toBe(false);
  });

  it("preserves execute function", async () => {
    const executeFn = vi.fn().mockResolvedValue("output");
    const myTool = tool({
      description: "My tool",
      inputSchema: z.object({ q: z.string() }),
      execute: executeFn,
    });
    const wrapped = wrapToolsWithPolicy({ myTool }, () => "auto_allow");
    // The execute is preserved (same reference or same behavior)
    await wrapped["myTool"]?.execute?.({ q: "hello" }, {} as never);
    expect(executeFn).toHaveBeenCalledWith({ q: "hello" }, expect.anything());
  });

  it("handles all three policies together", () => {
    const tools = {
      a: makeTool("a"),
      b: makeTool("b"),
      c: makeTool("c"),
    };
    const policyMap: Record<string, "auto_allow" | "approval_required" | "deny"> = {
      a: "auto_allow",
      b: "approval_required",
      c: "deny",
    };
    const wrapped = wrapToolsWithPolicy(tools, (name) => policyMap[name] ?? "approval_required");
    expect(Object.keys(wrapped).sort()).toEqual(["a", "b"]);
    expect(wrapped["a"]?.needsApproval).toBe(false);
    expect(wrapped["b"]?.needsApproval).toBe(true);
  });
});
