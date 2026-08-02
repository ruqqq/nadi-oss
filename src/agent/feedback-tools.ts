import { tool } from "ai";
import { z } from "zod";
import {
  feedbackReportFieldsSchema,
  type FeedbackDraftView,
  type FeedbackReportFields,
} from "../feedback/types";

export function createFeedbackTools(deps: {
  prepare: (
    input: FeedbackReportFields & { attachmentIds: string[] },
  ) => Promise<FeedbackDraftView>;
}) {
  return {
    prepare_feedback_report: tool({
      description: "Prepare a feedback draft for the user to review. This does not submit it.",
      inputSchema: feedbackReportFieldsSchema.extend({
        attachmentIds: z.array(z.string().min(1)).max(5),
      }),
      execute: (input) => deps.prepare(input),
    }),
  };
}
