import type { BatchItem } from "drizzle-orm/batch";
import { getAgentByName } from "agents";
import type { UIMessage } from "ai";
import { asc, eq } from "drizzle-orm";
import { validateRequestSession, type ValidatedSession } from "../auth/session";
import { registryDb } from "../db/client";
import { FeedbackRepository } from "../db/repositories/feedback";
import { ThreadRepository } from "../db/repositories/threads";
import { agents, attachments, feedbackThreads, threadIndex, workspaceMembers } from "../db/schema";
import type { Env } from "../env";
import { assertFeedbackReporter } from "../feedback/access";
import { requireFeedbackAdmin } from "../feedback/admin-auth";
import { notifyFeedbackAdmins } from "../feedback/notify-admins";
import {
  feedbackDiagnosticsSchema,
  feedbackReportFieldsSchema,
  type FeedbackDiagnostics,
  type FeedbackReportFields,
} from "../feedback/types";
import {
  PRESIGN_EXPIRES_SECONDS,
  PRESIGN_WINDOW_MS,
  bucketedAnchorMs,
  presignDepsFromEnv,
  presignGet,
} from "../storage/r2-presign";
import { serializeThread } from "./thread-serialize";
import type { SubmitFeedbackDraftResult } from "../agent/think-thread-agent";

const FEEDBACK_MODEL_PROVIDER = "workers-ai";
const FEEDBACK_MODEL_ID = "@cf/moonshotai/kimi-k2.7-code";

const SUBMIT_DRAFT_RE = /^\/api\/feedback\/drafts\/([^/]+)\/submit$/;
const ADMIN_DETAIL_RE = /^\/api\/admin\/feedback\/([^/]+)$/;
const ADMIN_SEEN_RE = /^\/api\/admin\/feedback\/([^/]+)\/seen$/;
const ADMIN_ATTACHMENT_RE = /^\/api\/admin\/feedback\/([^/]+)\/attachments\/([^/]+)$/;

const NO_STORE = { "Cache-Control": "no-store" };

export async function routeFeedback(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const url = new URL(req.url);
  const submitMatch = url.pathname.match(SUBMIT_DRAFT_RE);
  if (submitMatch?.[1]) {
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
    return submitFeedbackDraft(req, env, ctx, decodeURIComponent(submitMatch[1]));
  }
  const adminAttachmentMatch = url.pathname.match(ADMIN_ATTACHMENT_RE);
  if (adminAttachmentMatch?.[1] && adminAttachmentMatch[2]) {
    if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
    return getAdminFeedbackAttachment(
      req,
      env,
      decodeURIComponent(adminAttachmentMatch[1]),
      decodeURIComponent(adminAttachmentMatch[2]),
    );
  }
  const adminSeenMatch = url.pathname.match(ADMIN_SEEN_RE);
  if (adminSeenMatch?.[1]) {
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
    return markAdminFeedbackSeen(req, env, decodeURIComponent(adminSeenMatch[1]));
  }
  const adminDetailMatch = url.pathname.match(ADMIN_DETAIL_RE);
  if (adminDetailMatch?.[1]) {
    if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
    return getAdminFeedbackDetail(req, env, decodeURIComponent(adminDetailMatch[1]));
  }
  if (url.pathname === "/api/admin/feedback") {
    if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
    return listAdminFeedback(req, env, url);
  }
  if (url.pathname === "/api/feedback/messages") {
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
    return submitFeedbackMessage(req, env);
  }
  if (url.pathname === "/api/feedback/drafts") {
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
    return createFeedbackDraft(req, env);
  }
  if (url.pathname !== "/api/feedback/thread") return null;
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  return getOrCreateFeedbackThread(req, env);
}

interface FeedbackMessageStub {
  submitFeedbackUserMessage(input: { message: UIMessage }): Promise<
    | { ok: true }
    | {
        ok: false;
        retryAfterSeconds: number;
      }
  >;
}

interface FeedbackDraftStub {
  createManualFeedbackDraft(input: {
    interviewId: string;
    fromMessageId: string;
    fields: FeedbackReportFields;
    attachmentIds: string[];
  }): Promise<unknown>;
}

interface FeedbackSubmitStub {
  submitFeedbackDraft(input: {
    draftId: string;
    idempotencyKey: string;
    diagnostics: FeedbackDiagnostics;
  }): Promise<SubmitFeedbackDraftResult>;
}

interface FeedbackTranscriptStub {
  exportSubmittedFeedbackInterview(input: {
    interviewId: string;
    fromMessageId: string;
    toMessageId: string;
  }): Promise<unknown[]>;
}

async function readObjectBody(req: Request): Promise<Record<string, unknown> | Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return new Response("Invalid JSON", { status: 400 });
  }
  return body as Record<string, unknown>;
}

async function feedbackScopeForRequest(
  req: Request,
  env: Env,
  threadId: unknown,
): Promise<{ session: ValidatedSession; threadId: string } | Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });
  if (typeof threadId !== "string" || threadId.length === 0) {
    return new Response("Invalid feedback thread", { status: 400 });
  }
  const scope = await assertFeedbackReporter(env, threadId, session.user.id);
  if (!scope) return new Response("Not found", { status: 404 });
  return { session, threadId };
}

async function submitFeedbackMessage(req: Request, env: Env): Promise<Response> {
  const body = await readObjectBody(req);
  if (body instanceof Response) return body;
  const scoped = await feedbackScopeForRequest(req, env, body.threadId);
  if (scoped instanceof Response) return scoped;
  const stub = (await getAgentByName(
    env.THINK_THREAD_AGENT,
    scoped.threadId,
  )) as unknown as FeedbackMessageStub;
  try {
    const decision = await stub.submitFeedbackUserMessage({
      message: body.message as UIMessage,
    });
    if (!decision.ok) {
      return Response.json(
        { error: "feedback_rate_limited", retryAfterSeconds: decision.retryAfterSeconds },
        {
          status: 429,
          headers: { "Retry-After": String(decision.retryAfterSeconds) },
        },
      );
    }
  } catch (error) {
    const message = String(error);
    if (message.includes("queued_message_")) {
      return new Response("Message is empty or malformed", { status: 400 });
    }
    return new Response("Could not send feedback message", { status: 500 });
  }
  return Response.json({ ok: true }, { status: 202 });
}

async function createFeedbackDraft(req: Request, env: Env): Promise<Response> {
  const body = await readObjectBody(req);
  if (body instanceof Response) return body;
  const scoped = await feedbackScopeForRequest(req, env, body.threadId);
  if (scoped instanceof Response) return scoped;
  const fieldsResult = feedbackReportFieldsSchema.safeParse(body.fields);
  if (!fieldsResult.success) return new Response("Invalid feedback draft", { status: 400 });
  const attachmentIds = Array.isArray(body.attachmentIds) ? body.attachmentIds : [];
  if (
    attachmentIds.length > 5 ||
    !attachmentIds.every((id): id is string => typeof id === "string" && id.length > 0)
  ) {
    return new Response("Invalid feedback draft", { status: 400 });
  }
  const interviewId =
    typeof body.interviewId === "string" && body.interviewId.length > 0
      ? body.interviewId
      : `feedback_manual_${crypto.randomUUID()}`;
  const fromMessageId =
    typeof body.fromMessageId === "string" && body.fromMessageId.length > 0
      ? body.fromMessageId
      : `feedback_manual_${crypto.randomUUID()}`;
  const stub = (await getAgentByName(
    env.THINK_THREAD_AGENT,
    scoped.threadId,
  )) as unknown as FeedbackDraftStub;
  try {
    const draft = await stub.createManualFeedbackDraft({
      interviewId,
      fromMessageId,
      fields: fieldsResult.data,
      attachmentIds,
    });
    return Response.json({ draft }, { status: 200 });
  } catch (error) {
    const message = String(error);
    if (message.includes("feedback_attachment_not_found")) {
      return new Response("Invalid feedback draft", { status: 400 });
    }
    return new Response("Could not save feedback draft", { status: 500 });
  }
}

async function submitFeedbackDraft(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  draftId: string,
): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });
  const mapping = await new FeedbackRepository(registryDb(env)).getThreadForUser(session.user.id);
  if (!mapping) return new Response("Not found", { status: 404 });
  const body = await readObjectBody(req);
  if (body instanceof Response) return body;
  const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
  if (!idempotencyKey) return new Response("Invalid feedback submission", { status: 400 });
  const diagnostics = feedbackDiagnosticsSchema.safeParse(body.diagnostics);
  if (!diagnostics.success) return new Response("Invalid feedback submission", { status: 400 });

  const stub = (await getAgentByName(
    env.THINK_THREAD_AGENT,
    mapping.threadId,
  )) as unknown as FeedbackSubmitStub;
  let result: SubmitFeedbackDraftResult;
  try {
    result = await stub.submitFeedbackDraft({
      draftId,
      idempotencyKey,
      diagnostics: diagnostics.data,
    });
  } catch (error) {
    const message = String(error);
    if (
      message.includes("feedback_idempotency_key_required") ||
      message.includes("feedback_attachment_") ||
      message.includes("ZodError")
    ) {
      return new Response("Invalid feedback submission", { status: 400 });
    }
    return new Response("Could not submit feedback", { status: 500 });
  }

  if (!result.ok && result.reason === "stale_draft") {
    return Response.json({ error: "feedback_draft_stale" }, { status: 409 });
  }
  if (!result.ok && result.reason === "idempotency_collision") {
    return Response.json({ error: "feedback_draft_stale" }, { status: 409 });
  }
  if (!result.ok && result.reason === "rate_limited") {
    return Response.json(
      { error: "feedback_rate_limited", retryAfterSeconds: result.retryAfterSeconds },
      {
        status: 429,
        headers: { "Retry-After": String(result.retryAfterSeconds) },
      },
    );
  }

  if (result.created) {
    ctx.waitUntil(
      notifyFeedbackAdmins(env, {
        type: "feedback.report.created",
        reportId: result.report.id,
        submittedAt: result.report.submittedAt,
      }),
    );
  }

  return Response.json(
    { created: result.created, report: result.report },
    { status: result.created ? 201 : 200 },
  );
}

async function listAdminFeedback(req: Request, env: Env, url: URL): Promise<Response> {
  const admin = await requireFeedbackAdmin(req, env);
  if (admin instanceof Response) return admin;
  const limitRaw = Number(url.searchParams.get("limit") ?? "50");
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(Math.trunc(limitRaw), 100)) : 50;
  const cursor = url.searchParams.get("cursor");
  const repo = new FeedbackRepository(registryDb(env));
  const page = await repo.listReports({ limit, cursor });
  const reports = await Promise.all(
    page.reports.map(async (report) => ({
      ...report,
      seen: await repo.hasSeen({ reportId: report.id, adminUserId: admin.user.id }),
    })),
  );
  return Response.json({ reports, nextCursor: page.nextCursor }, { headers: NO_STORE });
}

async function getAdminFeedbackDetail(req: Request, env: Env, reportId: string): Promise<Response> {
  const admin = await requireFeedbackAdmin(req, env);
  if (admin instanceof Response) return admin;
  void admin;
  const repo = new FeedbackRepository(registryDb(env));
  const report = await repo.getReport(reportId);
  if (!report) return new Response("Not found", { status: 404, headers: NO_STORE });
  const stub = (await getAgentByName(
    env.THINK_THREAD_AGENT,
    report.threadId,
  )) as unknown as FeedbackTranscriptStub;
  let transcript: unknown[];
  try {
    transcript = await stub.exportSubmittedFeedbackInterview({
      interviewId: report.interviewId,
      fromMessageId: report.fromMessageId,
      toMessageId: report.toMessageId,
    });
  } catch (error) {
    if (!String(error).includes("feedback_interview_bounds_missing")) {
      return new Response("Could not load feedback transcript", { status: 500, headers: NO_STORE });
    }
    transcript = [];
  }
  const attachmentsView = report.attachmentIds.map((id) => ({
    id,
    url: `/api/admin/feedback/${encodeURIComponent(report.id)}/attachments/${encodeURIComponent(id)}`,
  }));
  return Response.json({ report, transcript, attachments: attachmentsView }, { headers: NO_STORE });
}

async function markAdminFeedbackSeen(req: Request, env: Env, reportId: string): Promise<Response> {
  const admin = await requireFeedbackAdmin(req, env);
  if (admin instanceof Response) return admin;
  const repo = new FeedbackRepository(registryDb(env));
  if (!(await repo.getReport(reportId))) {
    return new Response("Not found", { status: 404, headers: NO_STORE });
  }
  await repo.markSeen({ reportId, adminUserId: admin.user.id, seenAt: Date.now() });
  return Response.json({ ok: true }, { headers: NO_STORE });
}

async function getAdminFeedbackAttachment(
  req: Request,
  env: Env,
  reportId: string,
  attachmentId: string,
): Promise<Response> {
  const admin = await requireFeedbackAdmin(req, env);
  if (admin instanceof Response) return admin;
  const repo = new FeedbackRepository(registryDb(env));
  const report = await repo.getReport(reportId);
  if (!report || !(await repo.attachmentBelongsToReport({ reportId, attachmentId }))) {
    return new Response("Not found", { status: 404, headers: NO_STORE });
  }
  const row = await registryDb(env)
    .select({ r2Key: attachments.r2Key })
    .from(attachments)
    .where(eq(attachments.id, attachmentId))
    .get();
  if (!row) return new Response("Not found", { status: 404, headers: NO_STORE });
  const signed = await presignGet(presignDepsFromEnv(env), row.r2Key, {
    anchorMs: bucketedAnchorMs(Date.now(), PRESIGN_WINDOW_MS),
    expiresInSeconds: PRESIGN_EXPIRES_SECONDS,
  });
  return new Response(null, {
    status: 302,
    headers: { ...NO_STORE, location: signed },
  });
}

async function getOrCreateFeedbackThread(req: Request, env: Env): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const db = registryDb(env);
  const feedbackRepo = new FeedbackRepository(db);
  const existing = await feedbackRepo.getThreadForUser(session.user.id);
  if (existing) {
    const summary = await feedbackThreadSummary(env, existing.threadId);
    if (!summary) return new Response("Not found", { status: 404 });
    return Response.json({ thread: summary }, { status: 200 });
  }

  const target = await selectFeedbackThreadTarget(env, session);
  if (!target) return new Response("Workspace agent not found", { status: 404 });

  const now = Date.now();
  const thread = {
    id: `thr_${crypto.randomUUID()}`,
    workspaceId: target.workspaceId,
    agentId: target.agentId,
    kind: "feedback" as const,
    projectId: null,
    modelProvider: FEEDBACK_MODEL_PROVIDER,
    model: FEEDBACK_MODEL_ID,
    modelInputModalities: JSON.stringify(["text", "image"]),
    title: "Feedback",
    titleSet: true,
    runtime: "think" as const,
    source: "manual" as const,
    automatonId: null,
    automatonRunId: null,
    lastEventId: null,
    lastMessagePreview: "",
    createdAt: now,
    updatedAt: now,
  };

  const mapping = {
    userId: session.user.id,
    workspaceId: target.workspaceId,
    threadId: thread.id,
    createdAt: now,
    updatedAt: now,
  };
  const statements: BatchItem<"sqlite">[] = [
    db.insert(threadIndex).values(thread),
    db.insert(feedbackThreads).values(mapping),
  ];

  try {
    await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  } catch (error) {
    const winner = await feedbackRepo.getThreadForUser(session.user.id);
    if (!winner) throw error;
    const summary = await feedbackThreadSummary(env, winner.threadId);
    if (!summary) return new Response("Not found", { status: 404 });
    return Response.json({ thread: summary }, { status: 200 });
  }

  const summary = await feedbackThreadSummary(env, thread.id);
  if (!summary) return new Response("Not found", { status: 404 });
  return Response.json({ thread: summary }, { status: 201 });
}

async function feedbackThreadSummary(env: Env, threadId: string) {
  const row = await new ThreadRepository(registryDb(env)).getSummaryRowById(threadId);
  if (!row || row.kind !== "feedback") return null;
  return serializeThread(row);
}

async function selectFeedbackThreadTarget(env: Env, session: ValidatedSession) {
  return registryDb(env)
    .select({
      workspaceId: workspaceMembers.workspaceId,
      agentId: agents.id,
    })
    .from(workspaceMembers)
    .innerJoin(agents, eq(agents.workspaceId, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, session.user.id))
    .orderBy(asc(workspaceMembers.createdAt), asc(agents.createdAt))
    .get();
}
