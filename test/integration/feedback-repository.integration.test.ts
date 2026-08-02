import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../../src/db/schema";
import { FeedbackRepository } from "../../src/db/repositories/feedback";
import { applyRegistryTestSchema } from "./helpers/registry";
import { clearRegistry, seedUserWorkspace } from "./helpers/thread-seed";

const now = 1_800_000_000_000;

function db() {
  return drizzle(env.REGISTRY_DB, { schema });
}

async function seedFeedbackThread(input: {
  threadId: string;
  workspaceId: string;
  agentId: string;
}) {
  await db().insert(schema.threadIndex).values({
    id: input.threadId,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    kind: "feedback",
    title: "Feedback",
    runtime: "think",
    source: "manual",
    lastMessagePreview: "",
    createdAt: now,
    updatedAt: now,
  });
}

async function seedScreenshot(input: {
  id: string;
  threadId: string;
  workspaceId: string;
  ordinal: number;
}) {
  await db()
    .insert(schema.attachments)
    .values({
      id: input.id,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      mimeType: "image/png",
      filename: `screenshot-${input.ordinal}.png`,
      byteSize: 128 + input.ordinal,
      width: 1280,
      height: 720,
      r2Key: `feedback/${input.threadId}/${input.id}.png`,
      status: "ready",
      extractedText: null,
      extractedSource: null,
      extractedAt: null,
      extractedError: null,
      extractedAttempts: 0,
      createdAt: now + input.ordinal,
    });
}

async function clearFeedbackRegistry() {
  const conn = db();
  await conn.delete(schema.feedbackAdminReads);
  await conn.delete(schema.feedbackReportAttachments);
  await conn.delete(schema.feedbackReports);
  await conn.delete(schema.feedbackThreads);
  await conn.delete(schema.attachments);
  await clearRegistry();
}

describe("FeedbackRepository", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  beforeEach(async () => {
    await clearFeedbackRegistry();
  });

  it("stores one feedback thread per reporter and returns immutable report detail", async () => {
    const owner = await seedUserWorkspace("feedback-owner");
    const admin = await seedUserWorkspace("feedback-admin");
    const repo = new FeedbackRepository(db());

    await seedFeedbackThread({
      threadId: "thr_feedback_owner",
      workspaceId: owner.workspaceId,
      agentId: owner.agentId,
    });
    await seedFeedbackThread({
      threadId: "thr_feedback_duplicate",
      workspaceId: owner.workspaceId,
      agentId: owner.agentId,
    });
    await seedScreenshot({
      id: "att_1",
      threadId: "thr_feedback_owner",
      workspaceId: owner.workspaceId,
      ordinal: 0,
    });
    await seedScreenshot({
      id: "att_2",
      threadId: "thr_feedback_owner",
      workspaceId: owner.workspaceId,
      ordinal: 1,
    });

    await repo.createThreadMapping({
      userId: owner.userId,
      workspaceId: owner.workspaceId,
      threadId: "thr_feedback_owner",
      now,
    });
    await expect(
      repo.createThreadMapping({
        userId: owner.userId,
        workspaceId: owner.workspaceId,
        threadId: "thr_feedback_duplicate",
        now: now + 1,
      }),
    ).rejects.toThrow();
    expect(await repo.getThreadForUser(owner.userId)).toEqual({
      userId: owner.userId,
      workspaceId: owner.workspaceId,
      threadId: "thr_feedback_owner",
      createdAt: now,
      updatedAt: now,
    });

    await repo.createReport({
      id: "fbr_1",
      reporterUserId: owner.userId,
      workspaceId: owner.workspaceId,
      threadId: "thr_feedback_owner",
      interviewId: "fbi_1",
      fromMessageId: "msg_1",
      toMessageId: "msg_6",
      idempotencyKey: "confirm_1",
      fields: {
        category: "bug",
        title: "Archive button flickers",
        narrative: "The row returns after archiving.",
        reproductionSteps: ["Open All chats", "Archive a row"],
        expectedBehavior: "The row stays hidden.",
        actualBehavior: "The row reappears.",
        frequency: "Always",
        impact: "Cannot keep the list tidy",
      },
      diagnostics: {
        schemaVersion: 1,
        route: "/chats",
        build: "test",
        browser: "Chromium",
        os: "Linux",
        viewport: { width: 1280, height: 720 },
        theme: "dark",
        online: true,
      },
      attachmentIds: ["att_1", "att_2"],
      submittedAt: now,
    });

    await expect(
      repo.createReport({
        id: "fbr_replayed",
        reporterUserId: owner.userId,
        workspaceId: owner.workspaceId,
        threadId: "thr_feedback_owner",
        interviewId: "fbi_replayed",
        fromMessageId: "msg_1",
        toMessageId: "msg_6",
        idempotencyKey: "confirm_1",
        fields: {
          category: "general",
          title: "Ignored replay",
          narrative: "This should read back the first report.",
          reproductionSteps: [],
          expectedBehavior: null,
          actualBehavior: null,
          frequency: null,
          impact: null,
        },
        diagnostics: {
          schemaVersion: 1,
          route: "/ignored",
          build: "test",
          browser: "Chromium",
          os: "Linux",
          viewport: { width: 1, height: 1 },
          theme: "light",
          online: true,
        },
        attachmentIds: [],
        submittedAt: now + 1,
      }),
    ).resolves.toMatchObject({ id: "fbr_1", title: "Archive button flickers" });
    await repo.createReport({
      id: "fbr_2",
      reporterUserId: owner.userId,
      workspaceId: owner.workspaceId,
      threadId: "thr_feedback_owner",
      interviewId: "fbi_2",
      fromMessageId: "msg_7",
      toMessageId: "msg_9",
      idempotencyKey: "confirm_2",
      fields: {
        category: "feature",
        title: "Add bulk archive",
        narrative: "Archiving several chats one by one is slow.",
        reproductionSteps: [],
        expectedBehavior: null,
        actualBehavior: null,
        frequency: null,
        impact: "Cleaning the list takes longer than necessary",
      },
      diagnostics: {
        schemaVersion: 1,
        route: "/chats",
        build: "test",
        browser: "Chromium",
        os: "Linux",
        viewport: { width: 1280, height: 720 },
        theme: "dark",
        online: true,
      },
      attachmentIds: [],
      submittedAt: now + 10,
    });

    const detail = await repo.getReport("fbr_1");
    expect(detail?.attachmentIds).toEqual(["att_1", "att_2"]);
    expect(detail?.fields.reproductionSteps).toEqual(["Open All chats", "Archive a row"]);
    expect(detail?.diagnostics).toEqual({
      schemaVersion: 1,
      route: "/chats",
      build: "test",
      browser: "Chromium",
      os: "Linux",
      viewport: { width: 1280, height: 720 },
      theme: "dark",
      online: true,
    });
    expect(await repo.attachmentBelongsToReport({ reportId: "fbr_1", attachmentId: "att_2" })).toBe(
      true,
    );

    const listed = await repo.listReports({ limit: 1 });
    expect(listed.reports.map((report) => report.id)).toEqual(["fbr_2"]);
    expect((await repo.listReports({ limit: 1, cursor: listed.nextCursor })).reports[0]?.id).toBe(
      "fbr_1",
    );
    await repo.markSeen({ reportId: "fbr_1", adminUserId: admin.userId, seenAt: now + 10 });
    expect(await repo.hasSeen({ reportId: "fbr_1", adminUserId: admin.userId })).toBe(true);
  });
});
