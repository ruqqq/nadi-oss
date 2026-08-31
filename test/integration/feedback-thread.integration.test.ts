import { SELF, env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authorizeAgentRequest } from "../../src/agent-routing/authorize";
import * as schema from "../../src/db/schema";
import { applyRegistryTestSchema } from "./helpers/registry";

const now = 1_800_000_000_000;

function cookie(token: string) {
  return { cookie: `better-auth.session_token=${token}` };
}

async function clearRegistry() {
  const db = drizzle(env.REGISTRY_DB, { schema });
  await db.delete(schema.feedbackAdminReads);
  await db.delete(schema.feedbackReportAttachments);
  await db.delete(schema.feedbackReports);
  await db.delete(schema.feedbackThreads);
  await db.delete(schema.attachments);
  await db.delete(schema.threadRepositorySnapshots);
  await db.delete(schema.threadWorkbenchSnapshots);
  await db.delete(schema.threadIndex);
  await db.delete(schema.agents);
  await db.delete(schema.workspaceMembers);
  await db.delete(schema.workspaces);
  await db.delete(schema.sessions);
  await db.delete(schema.users);
}

async function seedUserWorkspace(input: {
  userId: string;
  token: string;
  workspaceId: string;
  role?: "owner" | "member";
  memberCreatedAt?: number;
}) {
  const db = drizzle(env.REGISTRY_DB, { schema });
  const agentId = `agent-${input.workspaceId}`;

  await db.insert(schema.users).values({
    id: input.userId,
    email: `${input.userId}@example.com`,
    name: null,
    createdAt: new Date(now),
    emailVerified: true,
    image: null,
    updatedAt: new Date(now),
  });
  await db.insert(schema.sessions).values({
    id: `session-${input.userId}`,
    userId: input.userId,
    token: input.token,
    expiresAt: new Date(now + 60_000),
    createdAt: new Date(now),
    updatedAt: new Date(now),
    ipAddress: null,
    userAgent: null,
  });
  await db
    .insert(schema.workspaces)
    .values({ id: input.workspaceId, name: input.workspaceId, createdAt: now })
    .onConflictDoNothing();
  await db.insert(schema.workspaceMembers).values({
    workspaceId: input.workspaceId,
    userId: input.userId,
    role: input.role ?? "owner",
    createdAt: input.memberCreatedAt ?? now,
  });
  await db
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

  return { ...input, agentId };
}

async function createFeedbackThread(token: string) {
  const res = await SELF.fetch("https://nadi.test/api/feedback/thread", {
    method: "POST",
    headers: cookie(token),
  });
  const body = (await res.json()) as { thread: { threadId: string; kind: string } };
  return { res, body };
}

function uploadBody() {
  const form = new FormData();
  form.set("file", new File([new Uint8Array([1, 2, 3])], "screenshot.png", { type: "image/png" }));
  return form;
}

describe("feedback thread", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  beforeEach(async () => {
    await clearRegistry();
  });

  it("creates one private feedback thread and excludes it from ordinary lists", async () => {
    const owner = await seedUserWorkspace({
      userId: "user-feedback-owner",
      token: "feedback-owner-token",
      workspaceId: "workspace-feedback",
    });

    const first = await createFeedbackThread(owner.token);
    const second = await createFeedbackThread(owner.token);
    expect(first.res.status).toBe(201);
    expect(second.res.status).toBe(200);
    expect(first.body.thread.kind).toBe("feedback");
    expect(first.body.thread.threadId).toBe(second.body.thread.threadId);

    const listed = await SELF.fetch("https://nadi.test/api/threads", {
      headers: cookie(owner.token),
    });
    expect((await listed.json<{ threads: Array<{ kind: string }> }>()).threads).toEqual([]);

    const genericGet = await SELF.fetch(
      `https://nadi.test/api/threads/${first.body.thread.threadId}`,
      { headers: cookie(owner.token) },
    );
    expect(genericGet.status).toBe(404);

    const reconcile = await SELF.fetch("https://nadi.test/api/threads/reconcile", {
      method: "POST",
      headers: { ...cookie(owner.token), "content-type": "application/json" },
      body: JSON.stringify({ threadIds: [first.body.thread.threadId] }),
    });
    expect(await reconcile.json<{ activeThreadIds: string[] }>()).toEqual({
      activeThreadIds: [],
    });
  });

  it("does not grant a workspace peer access to a feedback agent socket or upload", async () => {
    const owner = await seedUserWorkspace({
      userId: "user-feedback-owner",
      token: "feedback-owner-token",
      workspaceId: "workspace-feedback",
      memberCreatedAt: now,
    });
    const peer = await seedUserWorkspace({
      userId: "user-feedback-peer",
      token: "feedback-peer-token",
      workspaceId: "workspace-feedback",
      role: "member",
      memberCreatedAt: now + 1,
    });
    const created = await createFeedbackThread(owner.token);
    const feedbackThreadId = created.body.thread.threadId;

    const ownerAuth = await authorizeAgentRequest(
      new Request(`https://nadi.test/think-agents/think-thread-agent/${feedbackThreadId}`, {
        headers: cookie(owner.token),
      }),
      env,
    );
    expect(ownerAuth.authorized).toBe(true);

    const peerAuth = await authorizeAgentRequest(
      new Request(`https://nadi.test/think-agents/think-thread-agent/${feedbackThreadId}`, {
        headers: cookie(peer.token),
      }),
      env,
    );
    expect(peerAuth.authorized).toBe(false);

    const ownerUpload = await SELF.fetch(
      `https://nadi.test/api/threads/${feedbackThreadId}/attachments`,
      { method: "POST", headers: cookie(owner.token), body: uploadBody() },
    );
    expect(ownerUpload.status).toBe(201);

    const peerUpload = await SELF.fetch(
      `https://nadi.test/api/threads/${feedbackThreadId}/attachments`,
      { method: "POST", headers: cookie(peer.token), body: uploadBody() },
    );
    expect(peerUpload.status).toBe(404);
  });

  it("submits feedback messages through the rate-limited HTTP path", async () => {
    const owner = await seedUserWorkspace({
      userId: "user-feedback-message",
      token: "feedback-message-token",
      workspaceId: "workspace-feedback-message",
    });
    const created = await createFeedbackThread(owner.token);
    const threadId = created.body.thread.threadId;

    for (let i = 0; i < 30; i += 1) {
      const res = await SELF.fetch("https://nadi.test/api/feedback/messages", {
        method: "POST",
        headers: { ...cookie(owner.token), "content-type": "application/json" },
        body: JSON.stringify({
          threadId,
          message: {
            id: `feedback-msg-${i}`,
            role: "user",
            parts: [{ type: "text", text: `feedback message ${i}` }],
          },
        }),
      });
      expect(res.status).toBe(202);
    }

    const limited = await SELF.fetch("https://nadi.test/api/feedback/messages", {
      method: "POST",
      headers: { ...cookie(owner.token), "content-type": "application/json" },
      body: JSON.stringify({
        threadId,
        message: {
          id: "feedback-msg-31",
          role: "user",
          parts: [{ type: "text", text: "feedback message 31" }],
        },
      }),
    });
    expect(limited.status).toBe(429);
    const retryAfter = Number(limited.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(3600);
    const limitedBody = await limited.json<{
      error: string;
      retryAfterSeconds: number;
    }>();
    expect(limitedBody.error).toBe("feedback_rate_limited");
    expect(limitedBody.retryAfterSeconds).toBe(retryAfter);

    const replay = await SELF.fetch("https://nadi.test/api/feedback/messages", {
      method: "POST",
      headers: { ...cookie(owner.token), "content-type": "application/json" },
      body: JSON.stringify({
        threadId,
        message: {
          id: "feedback-msg-0",
          role: "user",
          parts: [{ type: "text", text: "feedback message 0" }],
        },
      }),
    });
    expect(replay.status).toBe(202);

    const stillLimited = await SELF.fetch("https://nadi.test/api/feedback/messages", {
      method: "POST",
      headers: { ...cookie(owner.token), "content-type": "application/json" },
      body: JSON.stringify({
        threadId,
        message: {
          id: "feedback-msg-32",
          role: "user",
          parts: [{ type: "text", text: "feedback message 32" }],
        },
      }),
    });
    expect(stillLimited.status).toBe(429);
  }, 20_000);

  it("stores manual feedback drafts without consuming a report slot", async () => {
    const owner = await seedUserWorkspace({
      userId: "user-feedback-draft",
      token: "feedback-draft-token",
      workspaceId: "workspace-feedback-draft",
    });
    const created = await createFeedbackThread(owner.token);
    const threadId = created.body.thread.threadId;

    const res = await SELF.fetch("https://nadi.test/api/feedback/drafts", {
      method: "POST",
      headers: { ...cookie(owner.token), "content-type": "application/json" },
      body: JSON.stringify({
        threadId,
        fields: {
          category: "bug",
          title: "Archive flickers",
          narrative: "The archive row returns after refresh.",
          reproductionSteps: ["Open all chats", "Archive a row", "Refresh"],
          expectedBehavior: "The row stays archived.",
          actualBehavior: "The row returns.",
          frequency: "Always",
          impact: "Inbox cleanup is unreliable.",
        },
        attachmentIds: [],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json<{
      draft: { fields: { title: string }; attachmentIds: string[] };
    }>();
    expect(body.draft.fields.title).toBe("Archive flickers");
    expect(body.draft.attachmentIds).toEqual([]);

    const db = drizzle(env.REGISTRY_DB, { schema });
    expect(await db.select().from(schema.feedbackReports).all()).toEqual([]);
  });
});
