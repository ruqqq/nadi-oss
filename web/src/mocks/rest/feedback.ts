import { http, HttpResponse } from "msw";
import type {
  FeedbackDiagnostics,
  FeedbackDraftView,
  FeedbackReportDetail,
  FeedbackReportSummary,
} from "../../feedback-api";
import type { ThreadSummary } from "../../threads-api";
import { getStore, readOnlyStateForThread } from "../store";
import { errorResponse, pathParam } from "./util";

const FEEDBACK_THREAD_ID = "thr_feedback_mock";

function now(): number {
  return Date.now();
}

function feedbackThread(): ThreadSummary {
  const store = getStore();
  if (store.feedback.thread) return store.feedback.thread;

  const timestamp = now();
  const thread: ThreadSummary = {
    threadId: FEEDBACK_THREAD_ID,
    kind: "feedback",
    workspaceId: store.settings?.workspace.id ?? "ws_mock",
    agentId: store.settings?.agent.id ?? "agent_mock",
    provider: "workers-ai",
    model: "@cf/moonshotai/kimi-k2.7-code",
    modelInputModalities: ["text", "image"],
    reasoningEffort: "medium",
    modelSupportsReasoning: null,
    runtime: "think",
    title: "Feedback",
    source: "manual",
    lastMessagePreview: "",
    archivedAt: null,
    // Derived, never hardcoded: the server builds this row through the same
    // `serializeThread` as every other thread (`src/http/feedback-routes.ts:454`),
    // so a disabled or deleted agent makes the feedback thread read-only there
    // too. Built here AND swept in `applyLiveReadOnly`, because this row is
    // memoized on the store and the server re-derives on every request.
    ...readOnlyStateForThread(
      { archivedAt: null, runtime: "think", agentId: store.settings?.agent.id ?? "agent_mock" },
      store.agents,
    ),
    status: "active",
    projectId: null,
    projectName: null,
    agentName: null,
    resourceProfile: "small",
    automatonId: null,
    automatonName: null,
    automatonNotifyMode: null,
    outcomeDismissedAt: null,
    recentDismissedAt: null,
    repositoryCount: 0,
    lastContextTokens: null,
    lastContextWindow: null,
    lastCompactAfterTokens: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  store.feedback.thread = thread;
  return thread;
}

function requireFeedbackAdmin(): Response | null {
  return getStore().features.feedbackAdmin
    ? null
    : errorResponse(403, "Only feedback admins can view feedback reports.");
}

function attachmentIdsFromMessage(message: unknown): string[] {
  const parts = (message as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return [];
  return parts
    .map((part) => {
      const file = part as { type?: unknown; attachmentId?: unknown; id?: unknown };
      return file.attachmentId ?? file.id;
    })
    .filter((id): id is string => typeof id === "string");
}

function summary(report: FeedbackReportDetail): FeedbackReportSummary {
  const seen = getStore().feedback.seenReportIds.includes(report.id);
  return {
    id: report.id,
    reporterUserId: report.reporterUserId,
    workspaceId: report.workspaceId,
    threadId: report.threadId,
    interviewId: report.interviewId,
    category: report.category,
    title: report.title,
    submittedAt: report.submittedAt,
    attachmentCount: report.attachmentCount,
    seen,
  };
}

function reportForDraft(draft: FeedbackDraftView, diagnostics: FeedbackDiagnostics): FeedbackReportDetail {
  const store = getStore();
  const timestamp = now();
  return {
    id: `fbr_${draft.id.replace(/^draft_/, "")}`,
    reporterUserId: store.session.authenticated ? store.session.user.id : "user_mock",
    workspaceId: store.settings?.workspace.id ?? "ws_mock",
    threadId: store.feedback.thread?.threadId ?? FEEDBACK_THREAD_ID,
    interviewId: draft.interviewId,
    category: draft.fields.category,
    title: draft.fields.title,
    submittedAt: timestamp,
    attachmentCount: draft.attachmentIds.length,
    seen: false,
    fromMessageId: "msg_feedback_user",
    toMessageId: "msg_feedback_draft",
    fields: draft.fields,
    diagnostics,
    attachmentIds: draft.attachmentIds,
  };
}

function textFromMessage(message: unknown): string {
  const parts = (message as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) => {
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function feedbackDraftMessage(draft: FeedbackDraftView): unknown {
  return {
    id: "msg_feedback_draft",
    role: "assistant",
    parts: [
      {
        type: "text",
        text: "I have enough detail to draft this feedback report. Please review it before sending.",
      },
      {
        type: "tool-prepare_feedback_report",
        toolCallId: "call_feedback_mock",
        state: "output-available",
        input: { category: draft.fields.category },
        output: { draft },
      },
    ],
  };
}

function transcriptFor(report: FeedbackReportDetail): unknown[] {
  const stored = getStore().feedback.transcriptsByReportId[report.id];
  if (stored) return stored;
  return [
    {
      id: report.fromMessageId,
      role: "user",
      parts: [
        { type: "text", text: report.fields.narrative },
        ...report.attachmentIds.map((id) => ({
          type: "file",
          attachmentId: id,
          mediaType: "image/png",
        })),
      ],
    },
    {
      id: report.toMessageId,
      role: "assistant",
      parts: [
        {
          type: "text",
          text: "I have enough detail to draft this feedback report. Please review it before sending.",
        },
        {
          type: "tool-prepare_feedback_report",
          toolCallId: `call_${report.id}`,
          state: "output-available",
          input: { category: report.category },
          output: { draft: reportToDraft(report) },
        },
      ],
    },
  ];
}

function reportToDraft(report: FeedbackReportDetail): FeedbackDraftView {
  return {
    id: `draft_${report.id.replace(/^fbr_/, "")}`,
    interviewId: report.interviewId,
    fields: report.fields,
    attachmentIds: report.attachmentIds,
    createdAt: report.submittedAt,
  };
}

export const feedbackHandlers = [
  http.post("*/api/feedback/thread", () => HttpResponse.json({ thread: feedbackThread() })),

  http.post("*/api/feedback/messages", async ({ request }) => {
    const store = getStore();
    const retryAfter = store.faults.feedbackRateLimitedRetryAfterSeconds;
    if (retryAfter !== null) {
      return HttpResponse.json(
        { error: "Too many feedback messages.", retryAfterSeconds: retryAfter },
        { status: 429, headers: { "Retry-After": String(retryAfter) } },
      );
    }
    if (store.faults.feedbackModelFails) {
      return errorResponse(503, "The feedback agent is unavailable.");
    }

    const body = (await request.json().catch(() => ({}))) as {
      threadId?: string;
      message?: unknown;
    };
    const thread = feedbackThread();
    thread.updatedAt = now();
    thread.lastMessagePreview = "Thanks — I can draft that report now.";
    const attachmentIds = attachmentIdsFromMessage(body.message);
    const userText = textFromMessage(body.message);
    const userMessage =
      typeof body.message === "object" && body.message !== null
        ? body.message
        : {
            id: "msg_feedback_user",
            role: "user",
            parts: [{ type: "text", text: userText }],
          };
    store.feedback.messages.push(userMessage);
    let draft = store.feedback.drafts[0];
    if (!draft) {
      draft = {
        id: "draft_feedback_mock",
        interviewId: "interview_feedback_mock",
        fields: {
          category: "bug",
          title: "Mock feedback report",
          narrative: userText || "The mock feedback route collected enough detail to prepare a report.",
          reproductionSteps: ["Open the feedback route", "Describe what happened"],
          expectedBehavior: "Nadi records the feedback clearly.",
          actualBehavior: "The mock prepared this draft for review.",
          frequency: "Once",
          impact: "Helps QA exercise the confirmation card.",
        },
        attachmentIds,
        createdAt: now(),
      };
      store.feedback.drafts.push(draft);
    }
    store.feedback.messages.push(feedbackDraftMessage(draft));
    return new HttpResponse(null, { status: 202 });
  }),

  http.post("*/api/feedback/drafts", async ({ request }) => {
    const store = getStore();
    const body = (await request.json().catch(() => ({}))) as Partial<FeedbackDraftView> & {
      threadId?: string;
      fromMessageId?: string;
    };
    const draft: FeedbackDraftView = {
      id: `draft_${crypto.randomUUID()}`,
      interviewId:
        typeof body.interviewId === "string" ? body.interviewId : `interview_${crypto.randomUUID()}`,
      fields: body.fields as FeedbackDraftView["fields"],
      attachmentIds: Array.isArray(body.attachmentIds) ? body.attachmentIds : [],
      createdAt: now(),
    };
    store.feedback.drafts.push(draft);
    feedbackThread();
    return HttpResponse.json({ draft }, { status: 200 });
  }),

  http.post("*/api/feedback/drafts/:draftId/submit", async ({ params, request }) => {
    const store = getStore();
    const draftId = pathParam(params, "draftId");
    const reportId = `fbr_${draftId.replace(/^draft_/, "")}`;
    const existing = store.feedback.reports.find((report) => report.id === reportId);
    if (existing) return HttpResponse.json({ created: false, report: existing });

    const draft = store.feedback.drafts.find((candidate) => candidate.id === draftId);
    if (!draft) return errorResponse(404, "That feedback draft couldn't be found.");

    const body = (await request.json().catch(() => ({}))) as { diagnostics?: FeedbackDiagnostics };
    const report = reportForDraft(draft, body.diagnostics ?? defaultDiagnostics());
    store.feedback.reports.unshift(report);
    store.feedback.transcriptsByReportId[report.id] =
      store.feedback.messages.length > 0 ? [...store.feedback.messages] : transcriptFor(report);
    store.feedback.drafts = store.feedback.drafts.filter((candidate) => candidate.id !== draft.id);
    return HttpResponse.json({ created: true, report }, { status: 201 });
  }),

  http.get("*/api/admin/feedback", ({ request }) => {
    const notAdmin = requireFeedbackAdmin();
    if (notAdmin) return notAdmin;

    const url = new URL(request.url);
    const limit = Number.parseInt(url.searchParams.get("limit") ?? "25", 10);
    const offset = Number.parseInt(url.searchParams.get("cursor") ?? "0", 10);
    const reports = [...getStore().feedback.reports].sort((a, b) => b.submittedAt - a.submittedAt);
    const page = reports.slice(offset, offset + limit).map(summary);
    const next = offset + limit < reports.length ? String(offset + limit) : null;
    return HttpResponse.json({ reports: page, nextCursor: next });
  }),

  http.get("*/api/admin/feedback/:reportId", ({ params }) => {
    const notAdmin = requireFeedbackAdmin();
    if (notAdmin) return notAdmin;

    const reportId = pathParam(params, "reportId");
    const report = getStore().feedback.reports.find((candidate) => candidate.id === reportId);
    if (!report) return errorResponse(404, "That feedback report couldn't be found.");
    return HttpResponse.json({
      report: { ...report, seen: getStore().feedback.seenReportIds.includes(report.id) },
      transcript: transcriptFor(report),
      attachments: report.attachmentIds.map((id) => ({
        id,
        url: `/api/admin/feedback/${encodeURIComponent(report.id)}/attachments/${encodeURIComponent(id)}`,
      })),
    });
  }),

  http.get("*/api/admin/feedback/:reportId/attachments/:attachmentId", ({ params }) => {
    const notAdmin = requireFeedbackAdmin();
    if (notAdmin) return notAdmin;

    const reportId = pathParam(params, "reportId");
    const attachmentId = pathParam(params, "attachmentId");
    const report = getStore().feedback.reports.find((candidate) => candidate.id === reportId);
    if (!report || !report.attachmentIds.includes(attachmentId)) {
      return errorResponse(404, "That feedback attachment couldn't be found.");
    }
    return mockPngResponse();
  }),

  http.post("*/api/admin/feedback/:reportId/seen", ({ params }) => {
    const notAdmin = requireFeedbackAdmin();
    if (notAdmin) return notAdmin;

    const reportId = pathParam(params, "reportId");
    if (!getStore().feedback.reports.some((report) => report.id === reportId)) {
      return errorResponse(404, "That feedback report couldn't be found.");
    }
    if (!getStore().feedback.seenReportIds.includes(reportId)) {
      getStore().feedback.seenReportIds.push(reportId);
    }
    return HttpResponse.json({ ok: true });
  }),
];

function defaultDiagnostics(): FeedbackDiagnostics {
  return {
    schemaVersion: 1,
    route: "/feedback",
    build: "mock-build",
    browser: "Mock browser",
    os: "Mock OS",
    viewport: { width: 1280, height: 800 },
    theme: "light",
    online: true,
  };
}

function mockPngResponse(): Response {
  const binary = atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Response(bytes, { headers: { "content-type": "image/png" } });
}
