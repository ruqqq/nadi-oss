import type { ToolSet } from "ai";

const THINK_THREAD_ROUTE = /^\/think-agents\/think-thread-agent\/([^/]+)(?:\/.*)?$/;

export function thinkRouteThreadId(pathname: string): string | null {
  return pathname.match(THINK_THREAD_ROUTE)?.[1] ?? null;
}

export function mergeThinkToolsStrict(toolSets: ToolSet[]): ToolSet {
  const merged: ToolSet = {};
  for (const tools of toolSets) {
    for (const [name, tool] of Object.entries(tools)) {
      if (Object.prototype.hasOwnProperty.call(merged, name)) {
        throw new Error(`tool_name_collision:${name}`);
      }
      merged[name] = tool;
    }
  }
  return merged;
}
