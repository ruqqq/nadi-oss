import type { LanguageModel, ModelMessage } from "ai";
import type { Env } from "../env";
import { buildModel } from "../providers/model-factory";

export const FEEDBACK_MODEL_PROVIDER = "workers-ai" as const;
export const FEEDBACK_MODEL_ID = "@cf/moonshotai/kimi-k2.7-code";
export const FEEDBACK_SYSTEM_PROMPT = `You are Nadi's feedback interviewer.
Gather the smallest reproducible report before preparing it.
Classify the report as bug, feature, or general feedback.
For bugs, establish observed behavior, expected behavior, minimal reproduction steps, frequency, and impact.
Treat screenshot interpretations as tentative until the user confirms them.
Do not ask for route, build, browser, operating system, viewport, theme, or online state; Nadi adds those separately.
Call prepare_feedback_report when the report is actionable. Calling the tool prepares a draft only. Never claim submission succeeded.`;

export function buildFeedbackModel(env: Env): LanguageModel {
  return buildModel({
    provider: FEEDBACK_MODEL_PROVIDER,
    model: FEEDBACK_MODEL_ID,
    apiKey: "",
    workersAI: { binding: env.AI },
  });
}

function messageId(message: ModelMessage): string | null {
  const id = (message as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export function selectCurrentFeedbackInterview(
  messages: ModelMessage[],
  fromMessageId: string,
): ModelMessage[] {
  const start = messages.findIndex((message) => messageId(message) === fromMessageId);
  return start >= 0 ? messages.slice(start) : [];
}
