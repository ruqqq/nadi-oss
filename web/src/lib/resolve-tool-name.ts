/**
 * Map an Agents SDK tool key back to a human-readable name.
 *
 * MCP tools arrive namespaced as `tool_<serverId>_<toolName>` (see
 * src/mcp/tool-key.ts). Server ids minted by `mcpServerId()` are already
 * normalized (lowercase, dash-free, leading letter), so `normalizeServerId`
 * is the identity for them and the key prefix is exactly `tool_<serverId>_`.
 * We therefore match by the raw server id without depending on the SDK's
 * normalizer. Built-in tools (e.g. `remember`) are not namespaced;
 * they get a friendly display label so no card shows a raw identifier.
 */

import { friendlyToolName } from "./friendly-tool-name";

export interface ToolNameServer {
  id: string;
  name: string;
}

export interface ResolvedToolName {
  /** MCP server display name, when the tool could be attributed to one. */
  server?: string;
  /** Bare tool name (e.g. "edit"), or the raw key when it can't be resolved. */
  tool: string;
  /** What to render: "Server · tool" for MCP tools, else the bare/raw name. */
  label: string;
}

export function resolveToolName(key: string, servers: ToolNameServer[]): ResolvedToolName {
  if (!key.startsWith("tool_")) {
    // Built-in / non-namespaced tool — map the raw key to a friendly label.
    return { tool: key, label: friendlyToolName(key) };
  }

  const body = key.slice("tool_".length);
  for (const server of servers) {
    const prefix = `${server.id}_`;
    if (body.startsWith(prefix) && body.length > prefix.length) {
      const tool = body.slice(prefix.length);
      return { server: server.name, tool, label: `${server.name} · ${tool}` };
    }
  }

  // Unknown server (still loading, or removed) — show the raw key rather than
  // guessing a split, so behavior never regresses below today's.
  return { tool: key, label: key };
}

/**
 * Summarize a list of tool names for a group subtitle, collapsing repeats into
 * counts in first-seen order: ["read","edit","edit"] → "read · edit ×2".
 */
export function summarizeToolNames(tools: string[]): string {
  const counts = new Map<string, number>();
  for (const tool of tools) counts.set(tool, (counts.get(tool) ?? 0) + 1);
  return Array.from(counts, ([tool, n]) => (n > 1 ? `${tool} ×${n}` : tool)).join(" · ");
}
