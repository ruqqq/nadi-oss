import type { BatchItem } from "drizzle-orm/batch";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { DrizzleQueryError } from "drizzle-orm/errors";
import type { D1Transaction, DrizzleD1Database } from "drizzle-orm/d1";
import {
  feedbackAdminReads,
  feedbackReportAttachments,
  feedbackReports,
  feedbackThreads,
} from "../schema";
import type * as schema from "../schema";
import {
  feedbackDiagnosticsSchema,
  feedbackReportCursorSchema,
  feedbackReportFieldsSchema,
  type FeedbackDiagnostics,
  type FeedbackReportDetail,
  type FeedbackReportFields,
  type FeedbackReportSummary,
} from "../../feedback/types";

type FeedbackDb = DrizzleD1Database<typeof schema> | D1Transaction<typeof schema, any>;

function supportsBatch(db: FeedbackDb): db is FeedbackDb & {
  batch: (statements: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]) => Promise<unknown[]>;
} {
  return "batch" in db && typeof db.batch === "function";
}

export interface FeedbackThreadMapping {
  userId: string;
  workspaceId: string;
  threadId: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreateFeedbackReportInput {
  id: string;
  reporterUserId: string;
  workspaceId: string;
  threadId: string;
  interviewId: string;
  fromMessageId: string;
  toMessageId: string;
  idempotencyKey: string;
  fields: FeedbackReportFields;
  diagnostics: FeedbackDiagnostics;
  attachmentIds: string[];
  submittedAt: number;
}

export interface FeedbackReportPage {
  reports: FeedbackReportSummary[];
  nextCursor: string | null;
}

function encodeCursor(report: { submittedAt: number; id: string }): string {
  return `${report.submittedAt}:${encodeURIComponent(report.id)}`;
}

function decodeCursor(cursor: string) {
  const [submittedAtRaw, idRaw] = cursor.split(":", 2);
  const submittedAt = Number(submittedAtRaw);
  return feedbackReportCursorSchema.parse({
    submittedAt,
    id: decodeURIComponent(idRaw ?? ""),
  });
}

function fieldsFromRow(row: typeof feedbackReports.$inferSelect): FeedbackReportFields {
  return feedbackReportFieldsSchema.parse({
    category: row.category,
    title: row.title,
    narrative: row.narrative,
    reproductionSteps: JSON.parse(row.reproductionStepsJson),
    expectedBehavior: row.expectedBehavior,
    actualBehavior: row.actualBehavior,
    frequency: row.frequency,
    impact: row.impact,
  });
}

function diagnosticsFromRow(row: typeof feedbackReports.$inferSelect): FeedbackDiagnostics {
  return feedbackDiagnosticsSchema.parse(JSON.parse(row.diagnosticsJson));
}

function summaryFromRow(
  row: typeof feedbackReports.$inferSelect,
  attachmentCount: number,
): FeedbackReportSummary {
  return {
    id: row.id,
    reporterUserId: row.reporterUserId,
    workspaceId: row.workspaceId,
    threadId: row.threadId,
    interviewId: row.interviewId,
    category: row.category,
    title: row.title,
    submittedAt: row.submittedAt,
    attachmentCount,
  };
}

export class FeedbackRepository {
  constructor(private readonly db: FeedbackDb) {}

  async getThreadForUser(userId: string): Promise<FeedbackThreadMapping | null> {
    return (
      (await this.db
        .select()
        .from(feedbackThreads)
        .where(eq(feedbackThreads.userId, userId))
        .get()) ?? null
    );
  }

  async createThreadMapping(input: {
    userId: string;
    workspaceId: string;
    threadId: string;
    now: number;
  }): Promise<FeedbackThreadMapping> {
    const row = {
      userId: input.userId,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      createdAt: input.now,
      updatedAt: input.now,
    };
    await this.db.insert(feedbackThreads).values(row);
    return row;
  }

  async createReport(input: CreateFeedbackReportInput): Promise<FeedbackReportDetail> {
    const fields = feedbackReportFieldsSchema.parse(input.fields);
    const diagnostics = feedbackDiagnosticsSchema.parse(input.diagnostics);

    return this.withTransactionalWrite(
      async (tx) => this.createReportRows(tx, input, fields, diagnostics),
      (db) => this.createReportWithBatch(db, input, fields, diagnostics),
    );
  }

  private async createReportRows(
    db: FeedbackDb,
    input: CreateFeedbackReportInput,
    fields: FeedbackReportFields,
    diagnostics: FeedbackDiagnostics,
  ): Promise<FeedbackReportDetail> {
    const inserted = await db
      .insert(feedbackReports)
      .values({
        id: input.id,
        reporterUserId: input.reporterUserId,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        interviewId: input.interviewId,
        fromMessageId: input.fromMessageId,
        toMessageId: input.toMessageId,
        category: fields.category,
        title: fields.title,
        narrative: fields.narrative,
        reproductionStepsJson: JSON.stringify(fields.reproductionSteps),
        expectedBehavior: fields.expectedBehavior,
        actualBehavior: fields.actualBehavior,
        frequency: fields.frequency,
        impact: fields.impact,
        diagnosticsJson: JSON.stringify(diagnostics),
        idempotencyKey: input.idempotencyKey,
        submittedAt: input.submittedAt,
      })
      .onConflictDoNothing({ target: feedbackReports.idempotencyKey })
      .returning({ id: feedbackReports.id })
      .get();

    if (inserted) {
      for (const [ordinal, attachmentId] of input.attachmentIds.entries()) {
        await db.insert(feedbackReportAttachments).values({
          reportId: input.id,
          attachmentId,
          ordinal,
        });
      }
      const detail = await new FeedbackRepository(db).getReport(input.id);
      if (!detail) throw new Error("feedback_report_create_failed");
      return detail;
    }

    const existing = await db
      .select({ id: feedbackReports.id, threadId: feedbackReports.threadId })
      .from(feedbackReports)
      .where(eq(feedbackReports.idempotencyKey, input.idempotencyKey))
      .get();
    if (!existing) throw new Error("feedback_report_idempotency_lookup_failed");
    if (existing.threadId !== input.threadId)
      throw new Error("feedback_report_idempotency_collision");
    const detail = await new FeedbackRepository(db).getReport(existing.id);
    if (!detail) throw new Error("feedback_report_idempotency_detail_failed");
    return detail;
  }

  private async createReportWithBatch(
    db: FeedbackDb,
    input: CreateFeedbackReportInput,
    fields: FeedbackReportFields,
    diagnostics: FeedbackDiagnostics,
  ): Promise<FeedbackReportDetail> {
    const existing = await db
      .select({ id: feedbackReports.id, threadId: feedbackReports.threadId })
      .from(feedbackReports)
      .where(eq(feedbackReports.idempotencyKey, input.idempotencyKey))
      .get();
    if (existing) {
      if (existing.threadId !== input.threadId) {
        throw new Error("feedback_report_idempotency_collision");
      }
      const detail = await new FeedbackRepository(db).getReport(existing.id);
      if (!detail) throw new Error("feedback_report_idempotency_detail_failed");
      return detail;
    }

    const statements: BatchItem<"sqlite">[] = [
      db.insert(feedbackReports).values({
        id: input.id,
        reporterUserId: input.reporterUserId,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        interviewId: input.interviewId,
        fromMessageId: input.fromMessageId,
        toMessageId: input.toMessageId,
        category: fields.category,
        title: fields.title,
        narrative: fields.narrative,
        reproductionStepsJson: JSON.stringify(fields.reproductionSteps),
        expectedBehavior: fields.expectedBehavior,
        actualBehavior: fields.actualBehavior,
        frequency: fields.frequency,
        impact: fields.impact,
        diagnosticsJson: JSON.stringify(diagnostics),
        idempotencyKey: input.idempotencyKey,
        submittedAt: input.submittedAt,
      }),
      ...input.attachmentIds.map((attachmentId, ordinal) =>
        db.insert(feedbackReportAttachments).values({
          reportId: input.id,
          attachmentId,
          ordinal,
        }),
      ),
    ];

    try {
      if (statements.length === 1) await statements[0]!;
      else if (supportsBatch(db)) {
        await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
      } else {
        for (const statement of statements) await statement;
      }
    } catch (error) {
      const racedExisting = await db
        .select({ id: feedbackReports.id, threadId: feedbackReports.threadId })
        .from(feedbackReports)
        .where(eq(feedbackReports.idempotencyKey, input.idempotencyKey))
        .get();
      if (!racedExisting) throw error;
      if (racedExisting.threadId !== input.threadId) {
        throw new Error("feedback_report_idempotency_collision");
      }
      const detail = await new FeedbackRepository(db).getReport(racedExisting.id);
      if (!detail) throw new Error("feedback_report_idempotency_detail_failed");
      return detail;
    }

    const detail = await new FeedbackRepository(db).getReport(input.id);
    if (!detail) throw new Error("feedback_report_create_failed");
    return detail;
  }

  async getReport(reportId: string): Promise<FeedbackReportDetail | null> {
    const row = await this.db
      .select()
      .from(feedbackReports)
      .where(eq(feedbackReports.id, reportId))
      .get();
    if (!row) return null;

    const attachmentRows = await this.db
      .select({ attachmentId: feedbackReportAttachments.attachmentId })
      .from(feedbackReportAttachments)
      .where(eq(feedbackReportAttachments.reportId, reportId))
      .orderBy(feedbackReportAttachments.ordinal)
      .all();

    return {
      ...summaryFromRow(row, attachmentRows.length),
      fromMessageId: row.fromMessageId,
      toMessageId: row.toMessageId,
      fields: fieldsFromRow(row),
      diagnostics: diagnosticsFromRow(row),
      attachmentIds: attachmentRows.map((attachment) => attachment.attachmentId),
    };
  }

  async getReportByIdempotencyKey(input: {
    threadId: string;
    idempotencyKey: string;
  }): Promise<FeedbackReportDetail | null> {
    const row = await this.db
      .select({ id: feedbackReports.id })
      .from(feedbackReports)
      .where(
        and(
          eq(feedbackReports.threadId, input.threadId),
          eq(feedbackReports.idempotencyKey, input.idempotencyKey),
        ),
      )
      .get();
    return row ? this.getReport(row.id) : null;
  }

  async getThreadByThreadId(threadId: string): Promise<FeedbackThreadMapping | null> {
    return (
      (await this.db
        .select()
        .from(feedbackThreads)
        .where(eq(feedbackThreads.threadId, threadId))
        .get()) ?? null
    );
  }

  async listReports(input: { limit: number; cursor?: string | null }): Promise<FeedbackReportPage> {
    const limit = Math.max(1, Math.min(input.limit, 100));
    const cursor = input.cursor ? decodeCursor(input.cursor) : null;
    const rows = await this.db
      .select()
      .from(feedbackReports)
      .where(
        cursor
          ? or(
              lt(feedbackReports.submittedAt, cursor.submittedAt),
              and(
                eq(feedbackReports.submittedAt, cursor.submittedAt),
                lt(feedbackReports.id, cursor.id),
              ),
            )
          : undefined,
      )
      .orderBy(desc(feedbackReports.submittedAt), desc(feedbackReports.id))
      .limit(limit + 1)
      .all();

    const pageRows = rows.slice(0, limit);
    const reports: FeedbackReportSummary[] = [];
    for (const row of pageRows) {
      const detail = await this.getReport(row.id);
      reports.push(summaryFromRow(row, detail?.attachmentIds.length ?? 0));
    }

    const last = pageRows.at(-1);
    return {
      reports,
      nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
    };
  }

  async markSeen(input: { reportId: string; adminUserId: string; seenAt: number }): Promise<void> {
    await this.db
      .insert(feedbackAdminReads)
      .values({
        reportId: input.reportId,
        adminUserId: input.adminUserId,
        seenAt: input.seenAt,
      })
      .onConflictDoUpdate({
        target: [feedbackAdminReads.reportId, feedbackAdminReads.adminUserId],
        set: { seenAt: input.seenAt },
      });
  }

  async hasSeen(input: { reportId: string; adminUserId: string }): Promise<boolean> {
    const row = await this.db
      .select({ reportId: feedbackAdminReads.reportId })
      .from(feedbackAdminReads)
      .where(
        and(
          eq(feedbackAdminReads.reportId, input.reportId),
          eq(feedbackAdminReads.adminUserId, input.adminUserId),
        ),
      )
      .get();
    return Boolean(row);
  }

  async attachmentBelongsToReport(input: {
    reportId: string;
    attachmentId: string;
  }): Promise<boolean> {
    const row = await this.db
      .select({ reportId: feedbackReportAttachments.reportId })
      .from(feedbackReportAttachments)
      .where(
        and(
          eq(feedbackReportAttachments.reportId, input.reportId),
          eq(feedbackReportAttachments.attachmentId, input.attachmentId),
        ),
      )
      .get();
    return Boolean(row);
  }

  private async withTransactionalWrite<T>(
    transactionalWrite: (tx: FeedbackDb) => Promise<T>,
    fallbackWrite: (db: FeedbackDb) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.db.transaction(async (tx) => transactionalWrite(tx));
    } catch (error) {
      if (this.isUnsupportedD1TransactionStartError(error)) {
        return fallbackWrite(this.db);
      }
      throw error;
    }
  }

  private isUnsupportedD1TransactionStartError(error: unknown): boolean {
    if (!(error instanceof DrizzleQueryError)) {
      return false;
    }
    if (error.query !== "begin" || error.params.length !== 0) {
      return false;
    }

    const cause = error.cause;
    return (
      cause instanceof Error &&
      cause.message.includes("please use the state.storage.transaction()") &&
      cause.message.includes("SQL BEGIN TRANSACTION")
    );
  }
}
