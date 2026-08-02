import { and, eq } from "drizzle-orm";
import { registryDb } from "../db/client";
import { mcpServers, mcpToolPolicies } from "../db/schema";
import type { Env } from "../env";
import type { ToolPolicy } from "./policy";
import { mcpToolKey } from "./tool-key";

const VALID_TOOL_POLICIES: readonly string[] = ["auto_allow", "approval_required", "deny"];

export interface EnabledMcpServer {
  id: string;
  name: string;
  url: string;
}

/**
 * List all enabled MCP servers for a workspace.
 */
export async function getEnabledMcpServers(
  env: Env,
  workspaceId: string,
): Promise<EnabledMcpServer[]> {
  const db = registryDb(env);
  const rows = await db
    .select({
      id: mcpServers.id,
      name: mcpServers.name,
      url: mcpServers.url,
    })
    .from(mcpServers)
    .where(and(eq(mcpServers.workspaceId, workspaceId), eq(mcpServers.enabled, true)));

  return rows.map((r) => ({ id: r.id, name: r.name, url: r.url }));
}

/**
 * Per-tool policies for a workspace, keyed by the SDK's namespaced tool key
 * (mcpToolKey), so callers can look up directly against getAITools() keys and
 * tools with the same name on different servers don't collide.
 */
export async function getMcpToolPolicyMap(
  env: Env,
  workspaceId: string,
): Promise<Record<string, ToolPolicy>> {
  const db = registryDb(env);
  const rows = await db
    .select({
      serverId: mcpToolPolicies.serverId,
      toolName: mcpToolPolicies.toolName,
      policy: mcpToolPolicies.policy,
    })
    .from(mcpToolPolicies)
    .where(eq(mcpToolPolicies.workspaceId, workspaceId));

  const result: Record<string, ToolPolicy> = {};
  for (const row of rows) {
    if (!VALID_TOOL_POLICIES.includes(row.policy)) continue;
    result[mcpToolKey(row.serverId, row.toolName)] = row.policy as ToolPolicy;
  }
  return result;
}
