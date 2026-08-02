import { tool, type ToolSet } from "ai";
import { z } from "zod";

export const AUTOMATON_OUTCOME_TOOL_NAME = "report_run_outcome";

export type AutomatonRunOutcome = {
  status: "done" | "blocked" | "failed";
  reason?: string;
};

export type AutomatonOutcomeState = {
  recordOutcome(outcome: AutomatonRunOutcome): Promise<void>;
};

/** Appended to the system prompt for automaton runs only. */
export const AUTOMATON_OUTCOME_CONTRACT = [
  "This is an unattended scheduled run — no one is watching it live.",
  "When you finish, call report_run_outcome exactly once:",
  '- status "done": you completed the task.',
  '- status "blocked": you could NOT proceed because something needs a human —',
  "  a missing/unconfigured tool or MCP, missing access, or a question only the user can answer.",
  '- status "failed": you attempted the task but it errored out.',
  "Always include a one-line `reason` for blocked or failed.",
].join("\n");

export function createAutomatonOutcomeTools(state: AutomatonOutcomeState): ToolSet {
  return {
    [AUTOMATON_OUTCOME_TOOL_NAME]: tool({
      description:
        "Report the outcome of this unattended automaton run. Call once when finished. Use 'blocked' if you could not proceed because something needs a human (missing configuration, an unavailable tool/MCP, or a question only the user can answer).",
      inputSchema: z.object({
        status: z.enum(["done", "blocked", "failed"]),
        reason: z.string().optional(),
      }),
      execute: async ({ status, reason }) => {
        await state.recordOutcome(reason === undefined ? { status } : { status, reason });
        return `Recorded run outcome: ${status}${reason ? ` (${reason})` : ""}.`;
      },
    }),
  };
}

export type AutomatonTurnEndDecision = "attention_required" | "failed" | "completed";

export function decideAutomatonTurnEnd(input: {
  hasPendingApproval: boolean;
  declaredOutcome: AutomatonRunOutcome | null;
}): AutomatonTurnEndDecision {
  if (input.hasPendingApproval) return "attention_required";
  if (input.declaredOutcome?.status === "blocked") return "attention_required";
  if (input.declaredOutcome?.status === "failed") return "failed";
  return "completed";
}
