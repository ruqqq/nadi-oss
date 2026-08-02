import { z } from "zod";

export const FEEDBACK_CATEGORIES = ["bug", "feature", "general"] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

export const feedbackReportFieldsSchema = z.object({
  category: z.enum(FEEDBACK_CATEGORIES),
  title: z.string().trim().min(1).max(120),
  narrative: z.string().trim().min(1).max(8_000),
  reproductionSteps: z.array(z.string().trim().min(1).max(1_000)).max(20),
  expectedBehavior: z.string().trim().max(4_000).nullable(),
  actualBehavior: z.string().trim().max(4_000).nullable(),
  frequency: z.string().trim().max(500).nullable(),
  impact: z.string().trim().max(2_000).nullable(),
});
export type FeedbackReportFields = z.infer<typeof feedbackReportFieldsSchema>;

export const feedbackDiagnosticsSchema = z
  .object({
    schemaVersion: z.literal(1),
    route: z.string().max(500),
    build: z.string().max(200),
    browser: z.string().max(200),
    os: z.string().max(200),
    viewport: z.object({
      width: z.number().int().min(0).max(20_000),
      height: z.number().int().min(0).max(20_000),
    }),
    theme: z.enum(["light", "dark"]),
    online: z.boolean(),
  })
  .strict();
export type FeedbackDiagnostics = z.infer<typeof feedbackDiagnosticsSchema>;

export interface FeedbackDraftView {
  id: string;
  interviewId: string;
  fields: FeedbackReportFields;
  attachmentIds: string[];
  createdAt: number;
}

export interface FeedbackReportSummary {
  id: string;
  reporterUserId: string;
  workspaceId: string;
  threadId: string;
  interviewId: string;
  category: FeedbackCategory;
  title: string;
  submittedAt: number;
  attachmentCount: number;
  seen?: boolean;
}

export interface FeedbackReportDetail extends FeedbackReportSummary {
  fromMessageId: string;
  toMessageId: string;
  fields: FeedbackReportFields;
  diagnostics: FeedbackDiagnostics;
  attachmentIds: string[];
}

export const feedbackReportCursorSchema = z
  .object({
    submittedAt: z.number().int(),
    id: z.string().min(1),
  })
  .strict();
export type FeedbackReportCursor = z.infer<typeof feedbackReportCursorSchema>;
