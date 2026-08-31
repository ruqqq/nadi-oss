/**
 * Run-loop step budget. A "step" is one model generation; a step that ends in
 * tool calls triggers another. 50 gives research-style and MCP-heavy runs ample
 * room for multi-step tool use while still bounding runaways.
 */
export const MAX_TOOL_STEPS = 50;

/**
 * Step budget for a turn that belongs to agent-declared coding work. Coding
 * runs legitimately need far more tool steps (read, edit, build, test, fix,
 * repeat) than chat, and they execute inside a Daytona sandbox that contains
 * filesystem/command blast radius. The sandbox does NOT contain model/DO spend,
 * so this stays a high *finite* backstop rather than unlimited: 500 unbroken
 * steps means the agent is almost certainly stuck, not working, and an
 * unattended stuck loop keeps the sandbox warm (idle-eviction never fires) until
 * something bounds it. See docs/superpowers/specs/2026-07-03-coding-task-tool-budget-design.md.
 */
export const CODING_MAX_TOOL_STEPS = 500;

/**
 * Pick the turn's step budget from whether the thread has an environment. An
 * environment declares repos, a setup script and a sandbox size — it is the
 * configuration-level statement that this thread does repository work. Keyed
 * here rather than on a model declaration so the budget is deterministic and
 * visible, and carries no hidden side effect on a tool documented as being
 * about something else.
 */
export function resolveToolStepBudget(hasWorkbench: boolean): number {
  return hasWorkbench ? CODING_MAX_TOOL_STEPS : MAX_TOOL_STEPS;
}

/**
 * opencode-style graceful wind-down: when the budget is exhausted, the model is
 * told to stop calling tools and summarize, instead of being silently cut off.
 */
export const TOOL_LIMIT_WINDDOWN_DIRECTIVE =
  "You've reached the tool-call limit for this turn. Do not call any more tools. " +
  "Summarize what you have accomplished so far and list the remaining steps so the user can continue.";

/**
 * The final step we allow; reached only under continuous tool-calling.
 * `maxSteps` is parameterized so tests can exercise the wind-down at a small
 * budget instead of looping the full production count.
 */
export function isFinalToolStep(stepNumber: number, maxSteps: number = MAX_TOOL_STEPS): boolean {
  return stepNumber === maxSteps - 1;
}

export function windDownSystemPrompt(systemPrompt: string): string {
  return `${systemPrompt}\n\n${TOOL_LIMIT_WINDDOWN_DIRECTIVE}`;
}
