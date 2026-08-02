import { describe, expect, it } from "vitest";
import { resolveToolName, summarizeToolNames } from "./resolve-tool-name";

// Server ids minted by mcpServerId() are already normalized (lowercase, dash-free,
// leading letter), so the Agents SDK tool key is exactly `tool_<serverId>_<toolName>`.
const servers = [
  { id: "s7b74bb8afba5470fbcaeb6502d3fef75", name: "Linear" },
  { id: "sa1b2c3d4", name: "Filesystem" },
];

describe("resolveToolName", () => {
  it("labels an MCP tool as 'Server · tool'", () => {
    const r = resolveToolName("tool_s7b74bb8afba5470fbcaeb6502d3fef75_edit", servers);
    expect(r).toEqual({ server: "Linear", tool: "edit", label: "Linear · edit" });
  });

  it("keeps underscores in the tool name", () => {
    const r = resolveToolName("tool_sa1b2c3d4_search_calendar", servers);
    expect(r).toEqual({
      server: "Filesystem",
      tool: "search_calendar",
      label: "Filesystem · search_calendar",
    });
  });

  it("gives a built-in (non-namespaced) tool a friendly label", () => {
    const r = resolveToolName("nameNewConversation", servers);
    expect(r).toEqual({ tool: "nameNewConversation", label: "Name conversation" });
  });

  it("falls back to the raw key when no server matches", () => {
    const r = resolveToolName("tool_sdeadbeef_edit", servers);
    expect(r).toEqual({ tool: "tool_sdeadbeef_edit", label: "tool_sdeadbeef_edit" });
  });

  it("falls back to the raw key when the servers list is empty (still loading)", () => {
    const r = resolveToolName("tool_s7b74bb8afba5470fbcaeb6502d3fef75_edit", []);
    expect(r.label).toBe("tool_s7b74bb8afba5470fbcaeb6502d3fef75_edit");
  });
});

describe("summarizeToolNames", () => {
  it("collapses repeats into counts, in first-seen order", () => {
    expect(summarizeToolNames(["read", "edit", "edit", "read", "read"])).toBe("read ×3 · edit ×2");
  });

  it("omits the count for a single occurrence", () => {
    expect(summarizeToolNames(["read", "edit"])).toBe("read · edit");
  });

  it("handles a lone name", () => {
    expect(summarizeToolNames(["edit"])).toBe("edit");
  });

  it("returns an empty string for no names", () => {
    expect(summarizeToolNames([])).toBe("");
  });
});
