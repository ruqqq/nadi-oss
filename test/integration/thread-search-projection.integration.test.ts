import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../../src/db/schema";
import { ThreadSearchProjectionRepository } from "../../src/db/repositories/thread-search-projection";
import { ThreadRepository } from "../../src/db/repositories/threads";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";
import { resetRegistryState } from "./helpers/reset";

async function matchingMessageIds(term: string): Promise<string[]> {
  const rows = await env.REGISTRY_DB.prepare(
    `
      SELECT message_id
      FROM thread_search_fts
      JOIN thread_search_messages ON thread_search_messages.id = thread_search_fts.rowid
      WHERE thread_search_fts MATCH ?
      ORDER BY message_id
    `,
  )
    .bind(term)
    .all<{ message_id: string }>();

  return rows.results.map((row) => row.message_id);
}

async function projectionRows(
  threadId: string,
): Promise<
  Array<{ messageId: string; content: string; sourceHash: string; indexedRevision: number }>
> {
  const rows = await env.REGISTRY_DB.prepare(
    `
      SELECT
        message_id AS messageId,
        content,
        source_hash AS sourceHash,
        indexed_revision AS indexedRevision
      FROM thread_search_messages
      WHERE thread_id = ?
      ORDER BY message_id
    `,
  )
    .bind(threadId)
    .all<{ messageId: string; content: string; sourceHash: string; indexedRevision: number }>();

  return rows.results;
}

async function threadProjectionMeta(threadId: string): Promise<{
  lastMessagePreview: string;
  searchIndexedThrough: number | null;
  updatedAt: number;
}> {
  const row = await env.REGISTRY_DB.prepare(
    `
      SELECT
        last_message_preview AS lastMessagePreview,
        search_indexed_through AS searchIndexedThrough,
        updated_at AS updatedAt
      FROM thread_index
      WHERE id = ?
    `,
  )
    .bind(threadId)
    .first<{
      lastMessagePreview: string;
      searchIndexedThrough: number | null;
      updatedAt: number;
    }>();

  if (!row) {
    throw new Error("missing thread");
  }
  return row;
}

describe("thread search projection reconciliation", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  beforeEach(async () => {
    await resetRegistryState(env.REGISTRY_DB);
  });

  it("reconciles projection rows without letting stale work regress the checkpoint", async () => {
    const { workspaceId, threadId } = await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-projection",
      threadId: "thread-projection",
      createdAt: 100,
      updatedAt: 200,
    });
    const db = drizzle(env.REGISTRY_DB, { schema });
    const threads = new ThreadRepository(db);
    const projection = new ThreadSearchProjectionRepository(env.REGISTRY_DB);

    await projection.reconcile({
      workspaceId,
      threadId,
      observedUpdatedAt: 200,
      currentMessageIds: ["msg_1", "msg_2"],
      changedDocuments: [
        {
          messageId: "msg_1",
          role: "user",
          createdAt: 101,
          content: "Alpha launch question",
          contentHash: "content-alpha-1",
          sourceHash: "source-alpha-1",
        },
        {
          messageId: "msg_2",
          role: "assistant",
          createdAt: 102,
          content: "Bravo launch answer",
          contentHash: "content-bravo-1",
          sourceHash: "source-bravo-1",
        },
      ],
      lastMessagePreview: "Bravo launch answer",
    });

    await expect(matchingMessageIds("Alpha")).resolves.toEqual(["msg_1"]);
    await expect(matchingMessageIds("Bravo")).resolves.toEqual(["msg_2"]);
    const firstRows = await projectionRows(threadId);
    expect(firstRows).toEqual([
      {
        messageId: "msg_1",
        content: "Alpha launch question",
        sourceHash: "source-alpha-1",
        indexedRevision: 200,
      },
      {
        messageId: "msg_2",
        content: "Bravo launch answer",
        sourceHash: "source-bravo-1",
        indexedRevision: 200,
      },
    ]);

    await projection.reconcile({
      workspaceId,
      threadId,
      observedUpdatedAt: 200,
      currentMessageIds: ["msg_1", "msg_2"],
      changedDocuments: [
        {
          messageId: "msg_1",
          role: "user",
          createdAt: 101,
          content: "Alpha launch question",
          contentHash: "content-alpha-1",
          sourceHash: "source-alpha-1",
        },
        {
          messageId: "msg_2",
          role: "assistant",
          createdAt: 102,
          content: "Bravo launch answer",
          contentHash: "content-bravo-1",
          sourceHash: "source-bravo-1",
        },
      ],
      lastMessagePreview: "Bravo launch answer",
    });

    await expect(projectionRows(threadId)).resolves.toEqual(firstRows);

    await threads.update(threadId, { updatedAt: 300 });
    await projection.reconcile({
      workspaceId,
      threadId,
      observedUpdatedAt: 300,
      currentMessageIds: ["msg_1"],
      changedDocuments: [
        {
          messageId: "msg_1",
          role: "user",
          createdAt: 101,
          content: "Charlie revised question",
          contentHash: "content-charlie-1",
          sourceHash: "source-alpha-2",
        },
      ],
      lastMessagePreview: "Charlie revised question",
    });

    await expect(matchingMessageIds("Alpha")).resolves.toEqual([]);
    await expect(matchingMessageIds("Bravo")).resolves.toEqual([]);
    await expect(matchingMessageIds("Charlie")).resolves.toEqual(["msg_1"]);
    await expect(projectionRows(threadId)).resolves.toEqual([
      {
        messageId: "msg_1",
        content: "Charlie revised question",
        sourceHash: "source-alpha-2",
        indexedRevision: 300,
      },
    ]);
    await expect(threadProjectionMeta(threadId)).resolves.toEqual({
      lastMessagePreview: "Charlie revised question",
      searchIndexedThrough: 300,
      updatedAt: 300,
    });

    await projection.reconcile({
      workspaceId,
      threadId,
      observedUpdatedAt: 250,
      currentMessageIds: ["msg_1", "msg_2"],
      changedDocuments: [
        {
          messageId: "msg_1",
          role: "user",
          createdAt: 101,
          content: "Alpha stale question",
          contentHash: "content-alpha-stale",
          sourceHash: "source-alpha-stale",
        },
        {
          messageId: "msg_2",
          role: "assistant",
          createdAt: 102,
          content: "Bravo stale answer",
          contentHash: "content-bravo-stale",
          sourceHash: "source-bravo-stale",
        },
      ],
      lastMessagePreview: "Stale preview",
    });

    await expect(projectionRows(threadId)).resolves.toEqual([
      {
        messageId: "msg_1",
        content: "Charlie revised question",
        sourceHash: "source-alpha-2",
        indexedRevision: 300,
      },
    ]);
    await expect(threadProjectionMeta(threadId)).resolves.toEqual({
      lastMessagePreview: "Charlie revised question",
      searchIndexedThrough: 300,
      updatedAt: 300,
    });

    await threads.updateSearchProjectionMeta(threadId, {
      observedUpdatedAt: 300,
      lastMessagePreview: "Metadata preview",
    });
    await expect(threadProjectionMeta(threadId)).resolves.toEqual({
      lastMessagePreview: "Metadata preview",
      searchIndexedThrough: 300,
      updatedAt: 300,
    });

    await threads.invalidateSearchCheckpoint(threadId);
    await expect(threadProjectionMeta(threadId)).resolves.toEqual({
      lastMessagePreview: "Metadata preview",
      searchIndexedThrough: null,
      updatedAt: 300,
    });

    await expect(projection.selectStaleThreads(5)).resolves.toEqual([
      {
        id: threadId,
        workspaceId,
        runtime: "legacy",
        archivedAt: null,
      },
    ]);
  });

  it("does not let stale overlapping work resurrect rows deleted by a newer reconcile", async () => {
    const { workspaceId, threadId } = await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-projection-race",
      threadId: "thread-projection-race",
      createdAt: 100,
      updatedAt: 200,
    });
    const db = drizzle(env.REGISTRY_DB, { schema });
    const threads = new ThreadRepository(db);
    const projection = new ThreadSearchProjectionRepository(env.REGISTRY_DB);

    await projection.reconcile({
      workspaceId,
      threadId,
      observedUpdatedAt: 200,
      currentMessageIds: ["msg_1", "msg_2"],
      changedDocuments: [
        {
          messageId: "msg_1",
          role: "user",
          createdAt: 101,
          content: "Alpha original question",
          contentHash: "content-alpha-original",
          sourceHash: "source-alpha-original",
        },
        {
          messageId: "msg_2",
          role: "assistant",
          createdAt: 102,
          content: "Bravo deleted answer",
          contentHash: "content-bravo-original",
          sourceHash: "source-bravo-original",
        },
      ],
      lastMessagePreview: "Bravo deleted answer",
    });

    await threads.update(threadId, { updatedAt: 300 });

    let batchCalls = 0;
    let injectedStaleReconcile = false;
    const racingBinding = new Proxy(env.REGISTRY_DB, {
      get(target, property, receiver) {
        if (property !== "batch") {
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }

        return async (statements: D1PreparedStatement[]) => {
          batchCalls += 1;
          const results = await target.batch(statements);
          if (batchCalls === 2) {
            injectedStaleReconcile = true;
            await projection.reconcile({
              workspaceId,
              threadId,
              observedUpdatedAt: 250,
              currentMessageIds: ["msg_1", "msg_2"],
              changedDocuments: [
                {
                  messageId: "msg_2",
                  role: "assistant",
                  createdAt: 102,
                  content: "Bravo stale answer",
                  contentHash: "content-bravo-stale",
                  sourceHash: "source-bravo-stale",
                },
              ],
              lastMessagePreview: "Stale preview",
            });
          }
          return results;
        };
      },
    }) as D1Database;

    await new ThreadSearchProjectionRepository(racingBinding).reconcile({
      workspaceId,
      threadId,
      observedUpdatedAt: 300,
      currentMessageIds: ["msg_1"],
      changedDocuments: [
        {
          messageId: "msg_1",
          role: "user",
          createdAt: 101,
          content: "Charlie revised question",
          contentHash: "content-charlie-revised",
          sourceHash: "source-alpha-revised",
        },
      ],
      lastMessagePreview: "Charlie revised question",
    });

    expect(injectedStaleReconcile).toBe(true);
    await expect(matchingMessageIds("Bravo")).resolves.toEqual([]);
    await expect(matchingMessageIds("Charlie")).resolves.toEqual(["msg_1"]);
    await expect(projectionRows(threadId)).resolves.toEqual([
      {
        messageId: "msg_1",
        content: "Charlie revised question",
        sourceHash: "source-alpha-revised",
        indexedRevision: 300,
      },
    ]);
    await expect(threadProjectionMeta(threadId)).resolves.toEqual({
      lastMessagePreview: "Charlie revised question",
      searchIndexedThrough: 300,
      updatedAt: 300,
    });
  });
});
