import type { ToolSet } from "ai";

export type ToolPolicy = "auto_allow" | "approval_required" | "deny";

export interface DecideToolPolicyOptions {
  defaultPolicy?: ToolPolicy;
  toolPolicy?: ToolPolicy;
}

/**
 * Decide the effective policy for a tool.
 * - toolPolicy takes priority over defaultPolicy
 * - defaultPolicy falls back to "approval_required"
 */
export function decideToolPolicy(options: DecideToolPolicyOptions): ToolPolicy {
  return options.toolPolicy ?? options.defaultPolicy ?? "approval_required";
}

/**
 * Wrap a ToolSet with policy enforcement:
 * - "deny" → tool is omitted entirely (not passed to model)
 * - "approval_required" → needsApproval: true (SDK pauses before execute)
 * - "auto_allow" → needsApproval: false (execute runs immediately)
 *
 * The original execute function is preserved as-is.
 */
export function wrapToolsWithPolicy(
  tools: ToolSet,
  policyFor: (toolName: string) => ToolPolicy,
): ToolSet {
  const result: ToolSet = {};
  for (const [name, t] of Object.entries(tools)) {
    const policy = policyFor(name);
    if (policy === "deny") continue;
    result[name] = {
      ...t,
      needsApproval: policy === "approval_required",
    };
  }
  return result;
}
