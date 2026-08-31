import { SELF, env, runInDurableObject } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../../src/db/schema";
import { applyRegistryTestSchema } from "./helpers/registry";

const now = 1_800_000_000_000;
const diagnostics = {
  schemaVersion: 1,
  route: "/threads/feedback",
  build: "test-build",
  browser: "Chromium",
  os: "Linux",
  viewport: { width: 1280, height: 720 },
  theme: "dark",
  online: true,
} as const;

const fields = {
  category: "bug",
  title: "Archive row flickers",
  narrative: "The archived row returns after refresh.",
  reproductionSteps: ["Open All chats", "Archive a row", "Refresh"],
  expectedBehavior: "The row stays archived.",
  actualBehavior: "The row returns.",
  frequency: "Always",
  impact: "The chat list cannot stay tidy.",
} as const;

function db() {
  return drizzle(env.REGISTRY_DB, { schema });
}

function cookie(token: string) {
  return { cookie: `better-auth.session_token=${token}` };
}

async function clearRegistry() {
  const conn = db();
  await conn.delete(schema.feedbackAdminReads);
  await conn.delete(schema.feedbackReportAttachments);
  await conn.delete(schema.feedbackReports);
  await conn.delete(schema.feedbackThreads);
  await conn.delete(schema.attachments);
  await conn.delete(schema.threadIndex);
  await conn.delete(schema.agents);
  await conn.delete(schema.workspaceMembers);
  await conn.delete(schema.workspaces);
  await conn.delete(schema.sessions);
  await conn.delete(schema.users);
}

async function seedUserWorkspace(input: {
  userId: string;
  token: string;
  email: string;
  workspaceId: string;
  role?: "owner" | "member";
}) {
  const agentId = `agent-${input.workspaceId}`;
  await db()
    .insert(schema.users)
    .values({
      id: input.userId,
      email: input.email,
      name: null,
      createdAt: new Date(now),
      emailVerified: true,
      image: null,
      updatedAt: new Date(now),
    });
  await db()
    .insert(schema.sessions)
    .values({
      id: `session-${input.userId}`,
      userId: input.userId,
      token: input.token,
      expiresAt: new Date(now + 60_000),
      createdAt: new Date(now),
      updatedAt: new Date(now),
      ipAddress: null,
      userAgent: null,
    });
  await db()
    .insert(schema.workspaces)
    .values({ id: input.workspaceId, name: input.workspaceId, createdAt: now })
    .onConflictDoNothing();
  await db()
    .insert(schema.workspaceMembers)
    .values({
      workspaceId: input.workspaceId,
      userId: input.userId,
      role: input.role ?? "owner",
      createdAt: now,
    });
  await db()
    .insert(schema.agents)
    .values({
      id: agentId,
      workspaceId: input.workspaceId,
      name: "Default",
      systemPrompt: "You are Nadi.",
      provider: "mock",
      model: "mock",
      modelInputModalities: JSON.stringify(["text", "image"]),
      createdAt: now,
    })
    .onConflictDoNothing();
  return { ...input, agentId };
}

async function createFeedbackThread(token: string) {
  const res = await SELF.fetch("https://nadi.test/api/feedback/thread", {
    method: "POST",
    headers: cookie(token),
  });
  const body = await res.json<{ thread: { threadId: string } }>();
  return { res, threadId: body.thread.threadId };
}

async function seedFeedbackTranscript(threadId: string) {
  const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));
  await runInDurableObject(stub, async (instance) => {
    const agent = instance as unknown as {
      __unsafe_ensureInitialized(): Promise<void>;
      addMessages(messages: unknown[]): Promise<void>;
    };
    await agent.__unsafe_ensureInitialized();
    await agent.addMessages([
      { id: "msg_feedback_start", role: "user", parts: [{ type: "text", text: "Archive bug" }] },
      {
        id: "msg_feedback_question",
        role: "assistant",
        parts: [{ type: "text", text: "What steps reproduce it?" }],
      },
      {
        id: "msg_feedback_answer",
        role: "user",
        parts: [{ type: "text", text: "Archive a row and refresh." }],
      },
      {
        id: "msg_feedback_draft",
        role: "assistant",
        parts: [{ type: "text", text: "Draft prepared." }],
      },
    ]);
  });
}

async function appendNextInterviewMessage(threadId: string) {
  const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));
  await runInDurableObject(stub, async (instance) => {
    const agent = instance as unknown as {
      __unsafe_ensureInitialized(): Promise<void>;
      addMessages(messages: unknown[]): Promise<void>;
    };
    await agent.__unsafe_ensureInitialized();
    await agent.addMessages([
      {
        id: "msg_next_interview",
        role: "user",
        parts: [{ type: "text", text: "A later report must not leak." }],
      },
    ]);
  });
}

async function feedbackThreadMessages(threadId: string) {
  const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));
  return runInDurableObject(stub, async (instance) => {
    const agent = instance as unknown as {
      getMessages(): Promise<
        Array<{ id: string; role: string; parts: Array<{ type: string; text?: string }> }>
      >;
    };
    return agent.getMessages();
  });
}

async function createDraft(token: string, threadId: string) {
  const res = await SELF.fetch("https://nadi.test/api/feedback/drafts", {
    method: "POST",
    headers: { ...cookie(token), "content-type": "application/json" },
    body: JSON.stringify({
      threadId,
      interviewId: "fbi_confirmed",
      fromMessageId: "msg_feedback_start",
      fields,
      attachmentIds: [],
    }),
  });
  const body = await res.json<{ draft: { id: string } }>();
  return { res, draftId: body.draft.id };
}

async function createManualFallbackDraft(token: string, threadId: string) {
  const res = await SELF.fetch("https://nadi.test/api/feedback/drafts", {
    method: "POST",
    headers: { ...cookie(token), "content-type": "application/json" },
    body: JSON.stringify({
      threadId,
      fields,
      attachmentIds: [],
    }),
  });
  const body = await res.json<{ draft: { id: string } }>();
  return { res, draftId: body.draft.id };
}

async function submitDraft(token: string, draftId: string, body: unknown) {
  const res = await SELF.fetch(`https://nadi.test/api/feedback/drafts/${draftId}/submit`, {
    method: "POST",
    headers: { ...cookie(token), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    body: await res.json<{ report: { id: string; submittedAt: number } }>(),
  };
}

async function listAsAdmin(token: string) {
  const res = await SELF.fetch("https://nadi.test/api/admin/feedback", {
    headers: cookie(token),
  });
  return res.json<{ reports: unknown[]; nextCursor: string | null }>();
}

async function getAdminReport(token: string, reportId: string) {
  const res = await SELF.fetch(`https://nadi.test/api/admin/feedback/${reportId}`, {
    headers: cookie(token),
  });
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  return res.json<{
    report: { id: string };
    transcript: Array<{ id: string }>;
    attachments: Array<{ id: string; url: string }>;
  }>();
}

describe("feedback confirmation and admin routes", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  beforeEach(async () => {
    await clearRegistry();
    (env as { FEEDBACK_ADMIN_EMAILS?: string }).FEEDBACK_ADMIN_EMAILS = "admin@example.com";
  });

  it("keeps drafts private, then reveals exactly the confirmed interview", async () => {
    const owner = await seedUserWorkspace({
      userId: "user-feedback-owner",
      token: "feedback-owner-token",
      email: "owner@example.com",
      workspaceId: "workspace-feedback-owner",
    });
    const admin = await seedUserWorkspace({
      userId: "user-feedback-admin",
      token: "feedback-admin-token",
      email: "admin@example.com",
      workspaceId: "workspace-feedback-admin",
    });
    const { threadId } = await createFeedbackThread(owner.token);
    await seedFeedbackTranscript(threadId);
    const draft = await createDraft(owner.token, threadId);
    await appendNextInterviewMessage(threadId);

    expect(await listAsAdmin(admin.token)).toEqual({ reports: [], nextCursor: null });
    const submitted = await submitDraft(owner.token, draft.draftId, {
      idempotencyKey: "confirm_1",
      diagnostics,
    });
    expect(submitted.status).toBe(201);
    expect(
      (await submitDraft(owner.token, draft.draftId, { idempotencyKey: "confirm_1", diagnostics }))
        .status,
    ).toBe(200);

    const threadMessages = await feedbackThreadMessages(threadId);
    expect(threadMessages.at(-1)).toMatchObject({
      role: "assistant",
      parts: [
        {
          type: "text",
          text: expect.stringContaining("Feedback sent"),
        },
      ],
    });
    expect(threadMessages.at(-1)?.parts[0]?.text).toContain("context");

    const listed = await listAsAdmin(admin.token);
    expect(listed.reports).toHaveLength(1);
    const detail = await getAdminReport(admin.token, submitted.body.report.id);
    expect(detail.report.id).toBe(submitted.body.report.id);
    expect(detail.transcript.map((message) => message.id)).toEqual([
      "msg_feedback_start",
      "msg_feedback_question",
      "msg_feedback_answer",
      "msg_feedback_draft",
    ]);
    expect(detail.transcript).not.toContainEqual(
      expect.objectContaining({ id: "msg_next_interview" }),
    );
    expect(detail.attachments).toEqual([]);
  }, 10_000);

  it("keeps manual fallback reports readable when transcript bounds are synthetic", async () => {
    const owner = await seedUserWorkspace({
      userId: "user-feedback-manual-owner",
      token: "feedback-manual-owner-token",
      email: "manual-owner@example.com",
      workspaceId: "workspace-feedback-manual-owner",
    });
    const admin = await seedUserWorkspace({
      userId: "user-feedback-manual-admin",
      token: "feedback-manual-admin-token",
      email: "admin@example.com",
      workspaceId: "workspace-feedback-manual-admin",
    });
    const { threadId } = await createFeedbackThread(owner.token);
    const draft = await createManualFallbackDraft(owner.token, threadId);

    const submitted = await submitDraft(owner.token, draft.draftId, {
      idempotencyKey: "confirm_manual",
      diagnostics,
    });

    expect(submitted.status).toBe(201);
    const detail = await getAdminReport(admin.token, submitted.body.report.id);
    expect(detail.report.id).toBe(submitted.body.report.id);
    expect(detail.transcript).toEqual([]);
    expect(detail.attachments).toEqual([]);
  });

  it("returns not found for non-admin list, detail, seen, and screenshot reads", async () => {
    const nonAdmin = await seedUserWorkspace({
      userId: "user-feedback-non-admin",
      token: "feedback-non-admin-token",
      email: "not-admin@example.com",
      workspaceId: "workspace-feedback-non-admin",
    });

    const nonAdminRequests = [
      new Request("https://nadi.test/api/admin/feedback", { headers: cookie(nonAdmin.token) }),
      new Request("https://nadi.test/api/admin/feedback/fbr_missing", {
        headers: cookie(nonAdmin.token),
      }),
      new Request("https://nadi.test/api/admin/feedback/fbr_missing/seen", {
        method: "POST",
        headers: cookie(nonAdmin.token),
      }),
      new Request("https://nadi.test/api/admin/feedback/fbr_missing/attachments/att_missing", {
        headers: cookie(nonAdmin.token),
      }),
    ];

    for (const request of nonAdminRequests) {
      expect((await SELF.fetch(request)).status).toBe(404);
    }
  });

  it("does not return another thread's report on idempotency-key collision", async () => {
    const first = await seedUserWorkspace({
      userId: "user-feedback-collision-1",
      token: "feedback-collision-token-1",
      email: "collision-1@example.com",
      workspaceId: "workspace-feedback-collision-1",
    });
    const second = await seedUserWorkspace({
      userId: "user-feedback-collision-2",
      token: "feedback-collision-token-2",
      email: "collision-2@example.com",
      workspaceId: "workspace-feedback-collision-2",
    });

    const firstThread = await createFeedbackThread(first.token);
    await seedFeedbackTranscript(firstThread.threadId);
    const firstDraft = await createDraft(first.token, firstThread.threadId);
    const firstSubmitted = await submitDraft(first.token, firstDraft.draftId, {
      idempotencyKey: "same_confirm_key",
      diagnostics,
    });
    expect(firstSubmitted.status).toBe(201);

    const secondThread = await createFeedbackThread(second.token);
    await seedFeedbackTranscript(secondThread.threadId);
    const secondDraft = await createDraft(second.token, secondThread.threadId);
    const secondSubmitted = await SELF.fetch(
      `https://nadi.test/api/feedback/drafts/${secondDraft.draftId}/submit`,
      {
        method: "POST",
        headers: { ...cookie(second.token), "content-type": "application/json" },
        body: JSON.stringify({ idempotencyKey: "same_confirm_key", diagnostics }),
      },
    );

    expect(secondSubmitted.status).toBe(409);
    expect(await secondSubmitted.json()).toEqual({ error: "feedback_draft_stale" });
    const reports = await db().select().from(schema.feedbackReports).all();
    expect(reports.map((report) => report.threadId)).toEqual([firstThread.threadId]);
  });
});
