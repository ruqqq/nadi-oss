import type { ToolUIPart } from "ai";

export function isActiveToolState(state: ToolUIPart["state"]): boolean {
  return (
    state === "input-streaming" || state === "input-available" || state === "approval-responded"
  );
}
