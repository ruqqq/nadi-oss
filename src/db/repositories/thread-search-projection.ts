const MAX_BATCH_STATEMENTS = 50;
const MESSAGE_ID_CHUNK_SIZE = 200;

export type SearchProjectionDocument = {
  messageId: string;
  role: "user" | "assistant";
  createdAt: number | null;
  content: string;
  contentHash: string;
  sourceHash: string;
};

export class ThreadSearchProjectionRepository {
  constructor(private readonly binding: D1Database) {}

  async listState(threadId: string): Promise<
    Array<{
      messageId: string;
      sourceHash: string;
      indexedRevision: number;
    }>
  > {
    const rows = await this.binding
      .prepare(
        `
          SELECT
            message_id AS messageId,
            source_hash AS sourceHash,
            indexed_revision AS indexedRevision
          FROM thread_search_messages
          WHERE thread_id = ?
          ORDER BY message_id
        `,
      )
      .bind(threadId)
      .all<{ messageId: string; sourceHash: string; indexedRevision: number }>();

    return rows.results;
  }

  async reconcile(input: {
    workspaceId: string;
    threadId: string;
    observedUpdatedAt: number;
    currentMessageIds: string[];
    changedDocuments: SearchProjectionDocument[];
    lastMessagePreview: string;
  }): Promise<void> {
    const changedMessageIds = new Set(input.changedDocuments.map((document) => document.messageId));
    const unchangedMessageIds = input.currentMessageIds.filter(
      (messageId) => !changedMessageIds.has(messageId),
    );

    await this.runBatches(this.buildStampStatements(input, unchangedMessageIds));
    await this.runBatches(this.buildUpsertStatements(input));
    await this.binding.batch([
      this.buildDeleteAbsentStatement(input),
      this.buildUpdateSearchProjectionMetaStatement(input),
    ]);
  }

  async deleteForThread(threadId: string): Promise<void> {
    await this.binding
      .prepare("DELETE FROM thread_search_messages WHERE thread_id = ?")
      .bind(threadId)
      .run();
  }

  async selectStaleThreads(limit: number): Promise<
    Array<{
      id: string;
      workspaceId: string;
      runtime: "legacy" | "think";
      archivedAt: number | null;
    }>
  > {
    const boundedLimit = Math.max(0, Math.floor(limit));
    if (boundedLimit === 0) {
      return [];
    }

    const rows = await this.binding
      .prepare(
        `
          SELECT
            id,
            workspace_id AS workspaceId,
            runtime,
            archived_at AS archivedAt
          FROM thread_index
          WHERE kind <> 'feedback'
            AND (
              search_indexed_through IS NULL
              OR search_indexed_through < updated_at
            )
          ORDER BY COALESCE(search_repair_attempts, 0) ASC, updated_at ASC, id ASC
          LIMIT ?
        `,
      )
      .bind(boundedLimit)
      .all<{
        id: string;
        workspaceId: string;
        runtime: "legacy" | "think";
        archivedAt: number | null;
      }>();

    return rows.results;
  }

  /**
   * Count every thread the repair batch would still have to visit. Repair is
   * bounded per run, so this is how a caller knows whether the backlog is
   * draining or wedged.
   */
  async countStaleThreads(): Promise<number> {
    const row = await this.binding
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM thread_index
          WHERE kind <> 'feedback'
            AND (
              search_indexed_through IS NULL
              OR search_indexed_through < updated_at
            )
        `,
      )
      .first<{ count: number }>();

    return Number(row?.count ?? 0);
  }

  /**
   * Rotate a thread that failed repair behind its healthy peers. Deliberately
   * does NOT stamp `search_indexed_through` — the thread is still stale and
   * must be retried, just not ahead of everything else on the next run.
   */
  async recordRepairFailure(threadId: string): Promise<void> {
    await this.binding
      .prepare(
        `
          UPDATE thread_index
          SET search_repair_attempts = COALESCE(search_repair_attempts, 0) + 1
          WHERE id = ?
        `,
      )
      .bind(threadId)
      .run();
  }

  private buildStampStatements(
    input: {
      threadId: string;
      observedUpdatedAt: number;
    },
    messageIds: string[],
  ): D1PreparedStatement[] {
    const statements: D1PreparedStatement[] = [];
    for (let index = 0; index < messageIds.length; index += MESSAGE_ID_CHUNK_SIZE) {
      const chunk = messageIds.slice(index, index + MESSAGE_ID_CHUNK_SIZE);
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => "?").join(", ");
      statements.push(
        this.binding
          .prepare(
            `
              UPDATE thread_search_messages
              SET indexed_revision = ?
              WHERE thread_id = ?
                AND message_id IN (${placeholders})
                AND indexed_revision <= ?
                AND ? >= COALESCE(
                  (SELECT search_indexed_through FROM thread_index WHERE id = ?),
                  -1
                )
            `,
          )
          .bind(
            input.observedUpdatedAt,
            input.threadId,
            ...chunk,
            input.observedUpdatedAt,
            input.observedUpdatedAt,
            input.threadId,
          ),
      );
    }
    return statements;
  }

  private buildUpsertStatements(input: {
    workspaceId: string;
    threadId: string;
    observedUpdatedAt: number;
    changedDocuments: SearchProjectionDocument[];
  }): D1PreparedStatement[] {
    return input.changedDocuments.map((document) =>
      this.binding
        .prepare(
          `
            INSERT INTO thread_search_messages (
              workspace_id, thread_id, message_id, role, created_at, content,
              content_hash, source_hash, indexed_revision
            )
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
            WHERE ? >= COALESCE(
              (SELECT search_indexed_through FROM thread_index WHERE id = ?),
              -1
            )
            ON CONFLICT(thread_id, message_id) DO UPDATE SET
              workspace_id = excluded.workspace_id,
              role = excluded.role,
              created_at = excluded.created_at,
              content = excluded.content,
              content_hash = excluded.content_hash,
              source_hash = excluded.source_hash,
              indexed_revision = excluded.indexed_revision
            WHERE excluded.indexed_revision >= thread_search_messages.indexed_revision
          `,
        )
        .bind(
          input.workspaceId,
          input.threadId,
          document.messageId,
          document.role,
          document.createdAt,
          document.content,
          document.contentHash,
          document.sourceHash,
          input.observedUpdatedAt,
          input.observedUpdatedAt,
          input.threadId,
        ),
    );
  }

  private buildDeleteAbsentStatement(input: {
    threadId: string;
    observedUpdatedAt: number;
  }): D1PreparedStatement {
    return this.binding
      .prepare(
        `
          DELETE FROM thread_search_messages
          WHERE thread_id = ?
            AND indexed_revision < ?
            AND ? >= COALESCE(
              (SELECT search_indexed_through FROM thread_index WHERE id = ?),
              -1
            )
        `,
      )
      .bind(input.threadId, input.observedUpdatedAt, input.observedUpdatedAt, input.threadId);
  }

  /**
   * Mirrors ThreadRepository.updateSearchProjectionMeta while letting reconcile
   * batch the authoritative delete and checkpoint update transactionally.
   */
  private buildUpdateSearchProjectionMetaStatement(input: {
    threadId: string;
    observedUpdatedAt: number;
    lastMessagePreview: string;
  }): D1PreparedStatement {
    return this.binding
      .prepare(
        `
          UPDATE thread_index
          SET
            search_indexed_through = CASE
              WHEN search_indexed_through IS NULL
                OR search_indexed_through < ?
                THEN ?
              ELSE search_indexed_through
            END,
            last_message_preview = CASE
              WHEN updated_at = ?
                THEN ?
              ELSE last_message_preview
            END,
            search_repair_attempts = NULL
          WHERE id = ?
        `,
      )
      .bind(
        input.observedUpdatedAt,
        input.observedUpdatedAt,
        input.observedUpdatedAt,
        input.lastMessagePreview,
        input.threadId,
      );
  }

  private async runBatches(statements: D1PreparedStatement[]): Promise<void> {
    for (let index = 0; index < statements.length; index += MAX_BATCH_STATEMENTS) {
      await this.binding.batch(statements.slice(index, index + MAX_BATCH_STATEMENTS));
    }
  }
}
