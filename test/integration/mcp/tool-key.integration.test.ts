// Runs in the workers pool (Miniflare) rather than the node "unit" project:
// src/mcp/tool-key.ts imports the real `agents` package (for normalizeServerId),
// whose top-level cloudflare:workers/email imports Node can't resolve. Running
// here exercises mcpToolKey against the SDK's actual normalizeServerId — no shim,
// no copied normalization logic to drift.
import { describe, it, expect } from "vitest";
import { mcpServerId, mcpToolKey } from "../../../src/mcp/tool-key";

describe("mcpServerId", () => {
  it("is normalization-safe: lowercase, starts with a letter, alphanumeric", () => {
    for (let i = 0; i < 50; i++) {
      const id = mcpServerId();
      expect(id).toMatch(/^[a-z][a-z0-9]*$/);
    }
  });
  it("is unique across calls", () => {
    expect(mcpServerId()).not.toBe(mcpServerId());
  });
});

describe("mcpToolKey", () => {
  it("matches the SDK namespaced format for normalization-safe ids", () => {
    expect(mcpToolKey("srvabc123", "search")).toBe("tool_srvabc123_search");
  });
  it("strips dashes from the server id", () => {
    expect(mcpToolKey("ab-cd-ef", "t")).toBe("tool_abcdef_t");
  });
  it("normalizes a non-safe server id the same way the SDK does", () => {
    // normalizeServerId("42-Things!") -> "id-42-things"; dashes then stripped
    expect(mcpToolKey("42-Things!", "do")).toBe("tool_id42things_do");
  });
  it("is a faithful pass-through for mcpServerId() output", () => {
    const id = mcpServerId();
    expect(mcpToolKey(id, "x")).toBe(`tool_${id}_x`);
  });
});
