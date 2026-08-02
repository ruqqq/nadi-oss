import type { ToolPolicy } from "../db/repositories/mcp-servers";

export interface DiscoveredTool {
  name: string;
  description: string | null;
}

export interface MergedTool extends DiscoveredTool {
  policy: ToolPolicy;
}

/**
 * Merge a server's discovered tools with its stored per-tool policies. A tool
 * with no stored policy defaults to "approval_required" — the same safe default
 * the runtime applies — so the UI always shows an explicit policy per tool.
 *
 * Pure (the `ToolPolicy` import is type-only and erased at runtime), so this
 * runs in the node "unit" test project without loading the `agents` package.
 */
export function mergeServerTools(
  tools: DiscoveredTool[],
  policyByToolName: Record<string, ToolPolicy>,
): MergedTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    policy: policyByToolName[tool.name] ?? "approval_required",
  }));
}
