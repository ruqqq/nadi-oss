import { normalizeServerId } from "agents";

/**
 * Generate an MCP server id that is already safe under the Agents SDK's
 * normalizeServerId (lowercase, starts with a letter, [a-z0-9] only), so the
 * SDK uses it verbatim as the stable id and the namespaced tool key is
 * deterministic. Starts with "s" to guarantee a leading letter.
 */
export function mcpServerId(): string {
  const rand = crypto.randomUUID().replace(/-/g, "").toLowerCase();
  return `s${rand}`;
}

/**
 * The key the Agents SDK uses for a tool in getAITools(): it normalizes the
 * server id with normalizeServerId, strips dashes, and joins as
 * `tool_<normalized serverId without dashes>_<toolName>`. We delegate to the
 * SDK's own normalizeServerId so this is correct for ANY stored id and tracks
 * the SDK if its normalization rules change. Verified against the Agents SDK
 * getAITools() source and the spike findings; there is no live pin test (the
 * test harness has no connectable MCP server).
 */
export function mcpToolKey(serverId: string, toolName: string): string {
  return `tool_${normalizeServerId(serverId).replace(/-/g, "")}_${toolName}`;
}
