import { SELF, env, runInDurableObject } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../../src/db/schema";
import { applyRegistryTestSchema } from "./helpers/registry";

const now = 1_800_000_000_000;
const diagnostics = {
  schemaVersion: 1,
  route: "/feedback/live",
  build: "test-build",
  browser: "Chromium",
  os: "Linux",
  viewport: { width: 1440, height: 900 },
  theme: "light",
  online: true,
} as const;
const fields = {
  category: "general",
  title: "Live event report title",
  narrative: "This content must not appear in the live event.",
  reproductionSteps: [],
  expectedBehavior: null,
  actualBehavior: null,
  frequency: null,
  impact: null,
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
  await conn.delete(schema.threadRepositorySnapshots);
  await conn.delete(schema.threadWorkbenchSnapshots);
  await conn.delete(schema.threadIndex);
  await conn.delete(schema.agents);
  await conn.delete(schema.workspaceMembers);
  await conn.delete(schema.workspaces);
  await conn.delete(schema.sessions);
  await conn.delete(schema.users);
}

async function seedUser(input: {
  userId: string;
  token: string;
  email: string;
  workspaceId: string;
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
  await db().insert(schema.workspaceMembers).values({
    workspaceId: input.workspaceId,
    userId: input.userId,
    role: "owner",
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
      modelInputModalities: JSON.stringify(["text"]),
      createdAt: now,
    })
    .onConflictDoNothing();
}

async function openLive(token: string) {
  const res = await SELF.fetch("https://nadi.test/live", {
    headers: { Upgrade: "websocket", ...cookie(token) },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  const received: unknown[] = [];
  ws.addEventListener("message", (event) => {
    received.push(JSON.parse(event.data as string));
  });
  return { received };
}

async function createThreadAndDraft(ownerToken: string) {
  const created = await SELF.fetch("https://nadi.test/api/feedback/thread", {
    method: "POST",
    headers: cookie(ownerToken),
  });
  const { thread } = await created.json<{ thread: { threadId: string } }>();
  const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(thread.threadId));
  await runInDurableObject(stub, async (instance) => {
    const agent = instance as unknown as {
      __unsafe_ensureInitialized(): Promise<void>;
      addMessages(messages: unknown[]): Promise<void>;
    };
    await agent.__unsafe_ensureInitialized();
    await agent.addMessages([
      { id: "msg_live_start", role: "user", parts: [{ type: "text", text: "Live report" }] },
      { id: "msg_live_draft", role: "assistant", parts: [{ type: "text", text: "Draft" }] },
    ]);
  });
  const draftRes = await SELF.fetch("https://nadi.test/api/feedback/drafts", {
    method: "POST",
    headers: { ...cookie(ownerToken), "content-type": "application/json" },
    body: JSON.stringify({
      threadId: thread.threadId,
      interviewId: "fbi_live",
      fromMessageId: "msg_live_start",
      fields,
      attachmentIds: [],
    }),
  });
  const { draft } = await draftRes.json<{ draft: { id: string } }>();
  return draft.id;
}

describe("feedback admin live events", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  beforeEach(async () => {
    await clearRegistry();
    (env as { FEEDBACK_ADMIN_EMAILS?: string }).FEEDBACK_ADMIN_EMAILS = "admin@example.com";
  });

  it("fans out a content-free event only to feedback admins after confirmation", async () => {
    await seedUser({
      userId: "user-live-owner",
      token: "feedback-live-owner-token",
      email: "owner@example.com",
      workspaceId: "workspace-live-owner",
    });
    await seedUser({
      userId: "user-live-admin",
      token: "feedback-live-admin-token",
      email: "Admin@Example.com",
      workspaceId: "workspace-live-admin",
    });
    await seedUser({
      userId: "user-live-other",
      token: "feedback-live-other-token",
      email: "other@example.com",
      workspaceId: "workspace-live-other",
    });
    const adminLive = await openLive("feedback-live-admin-token");
    const otherLive = await openLive("feedback-live-other-token");
    const draftId = await createThreadAndDraft("feedback-live-owner-token");

    const submitted = await SELF.fetch(`https://nadi.test/api/feedback/drafts/${draftId}/submit`, {
      method: "POST",
      headers: { ...cookie("feedback-live-owner-token"), "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "confirm_live_1", diagnostics }),
    });
    expect(submitted.status).toBe(201);
    const { report } = await submitted.json<{ report: { id: string; submittedAt: number } }>();

    await vi.waitFor(() => {
      expect(adminLive.received).toHaveLength(1);
    });
    expect(adminLive.received[0]).toEqual({
      type: "feedback.report.created",
      reportId: report.id,
      submittedAt: report.submittedAt,
    });
    expect(JSON.stringify(adminLive.received[0])).not.toContain(fields.title);
    expect(JSON.stringify(adminLive.received[0])).not.toContain(fields.narrative);
    expect(otherLive.received).toEqual([]);
  });
});
