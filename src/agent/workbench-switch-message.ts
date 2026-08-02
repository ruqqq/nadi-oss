import { buildSystemReminderMessage } from "./system-reminder";
import type { UIMessage } from "ai";

/**
 * Delivered when a user switches a live thread's workbench. The sandbox is
 * destroyed once the agent confirms, so anything unpushed is lost.
 */
export function buildWorkbenchSwitchMessage(workbenchName: string): UIMessage {
  return buildSystemReminderMessage(
    `The user is switching this thread to the "${workbenchName}" workbench. ` +
      `The current sandbox will be destroyed and replaced, so any uncommitted ` +
      `work in it will be lost. Commit and push anything worth keeping now, ` +
      `then call confirm_workbench_switch. If there is nothing to save, call ` +
      `confirm_workbench_switch immediately.`,
  );
}
