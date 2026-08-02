import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  reconcileThreadSearchProjection,
  reconcileThreadSearchProjectionFromMessages,
  scheduleLocalThreadSearchProjection,
} from "../../src/thread-knowledge/projector";
import { normalizeProseMessage } from "../../src/thread-knowledge/prose-normalizer";
import {
  THREAD_LAST_MESSAGE_PREVIEW_CHARS,
  type ActiveTranscriptRpc,
  type InternalGrepRequest,
  type InternalGrepResult,
  type InternalReadRequest,
  type InternalReadResult,
  type ThreadSearchDocument,
} from "../../src/thread-knowledge/types";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";
import { resetRegistryState } from "./helpers/reset";

type ProjectionRow = {
  messageId: string;
  role: "user" | "assistant";
  createdAt: number | null;
  content: string;
  sourceHash: string;
  contentHash: string;
  indexedRevision: number;
};

function message(input: {
  id: string;
  role?: "user" | "assistant" | "system" | "tool";
  text?: string;
  createdAt?: number | string | null;
  extraParts?: unknown[];
}) {
  return {
    id: input.id,
    role: input.role ?? "user",
    createdAt: input.createdAt ?? 1_800_000_000_000,
    parts: [
      ...(input.text === undefined ? [] : [{ type: "text", text: input.text }]),
      ...(input.extraParts ?? []),
    ],
  };
}

function sourceHash(raw: unknown): string {
  return `source:${JSON.stringify(raw)}`;
}

function makeSource(
  messages: unknown[],
  options: { failDocumentFetch?: boolean } = {},
): ActiveTranscriptRpc & { documentRequests: string[][] } {
  const documentRequests: string[][] = [];
  const byId = new Map(
    messages
      .filter((raw): raw is { id: string } => typeof raw === "object" && raw !== null)
      .filter((raw) => typeof raw.id === "string")
      .map((raw) => [raw.id, raw]),
  );

  return {
    documentRequests,
    async readThreadProsePage(_input: InternalReadRequest): Promise<InternalReadResult> {
      throw new Error("unused");
    },
    async grepThreadProse(_input: InternalGrepRequest): Promise<InternalGrepResult> {
      throw new Error("unused");
    },
    async listThreadSearchDigests(input) {
      const start = input.afterPosition === undefined ? 0 : input.afterPosition + 1;
      const page = messages.slice(start, start + input.limit);
      let lastMessagePreview = "";
      const digests = page.map((raw) => {
        const normalized = normalizeProseMessage(raw);
        if (normalized.message !== null) {
          lastMessagePreview = normalized.message.text.slice(0, THREAD_LAST_MESSAGE_PREVIEW_CHARS);
        }
        return {
          messageId:
            typeof raw === "object" &&
            raw !== null &&
            typeof (raw as { id?: unknown }).id === "string"
              ? (raw as { id: string }).id
              : `raw:${start}`,
          sourceHash: sourceHash(raw),
          indexable: normalized.message !== null,
        };
      });
      const endPosition = start + page.length - 1;
      return {
        digests,
        ...(start + page.length < messages.length ? { nextPosition: endPosition } : {}),
        lastMessagePreview,
      };
    },
    async getThreadSearchDocuments(messageIds: string[]): Promise<ThreadSearchDocument[]> {
      documentRequests.push([...messageIds]);
      if (options.failDocumentFetch) throw new Error("simulated document fetch failure");
      return messageIds.flatMap((messageId) => {
        const raw = byId.get(messageId);
        const normalized = normalizeProseMessage(raw);
        if (normalized.message === null) return [];
        return [{ message: normalized.message, sourceHash: sourceHash(raw) }];
      });
    },
  };
}

async function projectionRows(threadId: string): Promise<ProjectionRow[]> {
  const rows = await env.REGISTRY_DB.prepare(
    `
      SELECT
        message_id AS messageId,
        role,
        created_at AS createdAt,
        content,
        source_hash AS sourceHash,
        content_hash AS contentHash,
        indexed_revision AS indexedRevision
      FROM thread_search_messages
      WHERE thread_id = ?
      ORDER BY message_id
    `,
  )
    .bind(threadId)
    .all<ProjectionRow>();

  return rows.results;
}

async function threadMeta(threadId: string): Promise<{
  updatedAt: number;
  lastMessagePreview: string;
  searchIndexedThrough: number | null;
}> {
  const row = await env.REGISTRY_DB.prepare(
    `
      SELECT
        updated_at AS updatedAt,
        last_message_preview AS lastMessagePreview,
        search_indexed_through AS searchIndexedThrough
      FROM thread_index
      WHERE id = ?
    `,
  )
    .bind(threadId)
    .first<{
      updatedAt: number;
      lastMessagePreview: string;
      searchIndexedThrough: number | null;
    }>();

  if (!row) throw new Error(`missing thread ${threadId}`);
  return row;
}

async function setThreadUpdatedAt(threadId: string, updatedAt: number): Promise<void> {
  await env.REGISTRY_DB.prepare("UPDATE thread_index SET updated_at = ? WHERE id = ?")
    .bind(updatedAt, threadId)
    .run();
}

describe("thread search projector", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  beforeEach(async () => {
    await resetRegistryState(env.REGISTRY_DB);
  });

  it("indexes only user and assistant prose, then avoids unchanged document transfers", async () => {
    const longAssistantText = `${"latest ".repeat(40)}tail`;
    const { threadId } = await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-projector",
      threadId: "thread-projector",
      runtime: "think",
      createdAt: 100,
      updatedAt: 200,
    });
    const source = makeSource([
      message({ id: "msg-user", text: "Visible user question", createdAt: 101 }),
      message({
        id: "msg-tool-result",
        role: "assistant",
        createdAt: 102,
        extraParts: [{ type: "tool-result", output: "hidden" }],
      }),
      message({ id: "msg-system", role: "system", text: "hidden system", createdAt: 103 }),
      message({ id: "msg-assistant", role: "assistant", text: longAssistantText, createdAt: 104 }),
    ]);

    await scheduleAndWait(threadId, source);

    const rows = await projectionRows(threadId);
    expect(rows).toEqual([
      {
        messageId: "msg-assistant",
        role: "assistant",
        createdAt: 104,
        content: longAssistantText,
        sourceHash: expect.any(String),
        contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        indexedRevision: 200,
      },
      {
        messageId: "msg-user",
        role: "user",
        createdAt: 101,
        content: "Visible user question",
        sourceHash: expect.any(String),
        contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        indexedRevision: 200,
      },
    ]);
    expect(source.documentRequests).toEqual([["msg-user", "msg-assistant"]]);
    await expect(threadMeta(threadId)).resolves.toEqual({
      updatedAt: 200,
      lastMessagePreview: longAssistantText.slice(0, THREAD_LAST_MESSAGE_PREVIEW_CHARS),
      searchIndexedThrough: 200,
    });

    await scheduleAndWait(threadId, source);

    expect(source.documentRequests).toEqual([["msg-user", "msg-assistant"]]);
    await expect(projectionRows(threadId)).resolves.toEqual(rows);
  });

  it("updates changed messages and deletes projection rows no longer present in the source", async () => {
    const { threadId } = await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-projector-update",
      threadId: "thread-projector-update",
      runtime: "think",
      createdAt: 100,
      updatedAt: 200,
    });
    const first = makeSource([
      message({ id: "msg-user", text: "Original user question", createdAt: 101 }),
      message({
        id: "msg-assistant",
        role: "assistant",
        text: "Original assistant answer",
        createdAt: 102,
      }),
    ]);
    await scheduleAndWait(threadId, first);

    await setThreadUpdatedAt(threadId, 300);
    const revised = makeSource([
      message({ id: "msg-user", text: "Revised user question", createdAt: 101 }),
    ]);
    await scheduleAndWait(threadId, revised);

    expect(revised.documentRequests).toEqual([["msg-user"]]);
    await expect(projectionRows(threadId)).resolves.toEqual([
      {
        messageId: "msg-user",
        role: "user",
        createdAt: 101,
        content: "Revised user question",
        sourceHash: expect.any(String),
        contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        indexedRevision: 300,
      },
    ]);
    await expect(threadMeta(threadId)).resolves.toEqual({
      updatedAt: 300,
      lastMessagePreview: "Revised user question",
      searchIndexedThrough: 300,
    });
  });

  it("leaves the checkpoint stale when changed document fetch fails", async () => {
    const { threadId } = await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-projector-failure",
      threadId: "thread-projector-failure",
      runtime: "think",
      createdAt: 100,
      updatedAt: 200,
    });
    const source = makeSource(
      [message({ id: "msg-user", text: "Unfetched user question", createdAt: 101 })],
      { failDocumentFetch: true },
    );

    await expect(reconcileThreadSearchProjectionFromSource(threadId, source)).rejects.toThrow(
      "simulated document fetch failure",
    );

    await expect(projectionRows(threadId)).resolves.toEqual([]);
    await expect(threadMeta(threadId)).resolves.toEqual({
      updatedAt: 200,
      lastMessagePreview: "",
      searchIndexedThrough: null,
    });
  });

  it("does not let an older revision regress newer projected rows or metadata", async () => {
    const { threadId } = await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-projector-race",
      threadId: "thread-projector-race",
      createdAt: 100,
      updatedAt: 200,
    });

    await setThreadUpdatedAt(threadId, 300);
    await reconcileThreadSearchProjectionFromMessages(env, {
      threadId,
      observedUpdatedAt: 300,
      messages: [message({ id: "msg-user", text: "Newer projection", createdAt: 101 })],
    });
    await reconcileThreadSearchProjectionFromMessages(env, {
      threadId,
      observedUpdatedAt: 250,
      messages: [
        message({ id: "msg-user", text: "Stale projection", createdAt: 101 }),
        message({
          id: "msg-old",
          role: "assistant",
          text: "Stale resurrected row",
          createdAt: 102,
        }),
      ],
    });

    await expect(projectionRows(threadId)).resolves.toEqual([
      {
        messageId: "msg-user",
        role: "user",
        createdAt: 101,
        content: "Newer projection",
        sourceHash: expect.any(String),
        contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        indexedRevision: 300,
      },
    ]);
    await expect(threadMeta(threadId)).resolves.toEqual({
      updatedAt: 300,
      lastMessagePreview: "Newer projection",
      searchIndexedThrough: 300,
    });
  });

  it("skips unregistered facet IDs and feedback threads", async () => {
    await expect(reconcileThreadSearchProjection(env, "subagent-facet-only")).resolves.toBe(
      "skipped",
    );

    const { threadId } = await seedRegistryThread(env.REGISTRY_DB, {
      workspaceId: "workspace-projector-feedback",
      threadId: "thread-projector-feedback",
      runtime: "think",
      createdAt: 100,
      updatedAt: 200,
    });
    await env.REGISTRY_DB.prepare("UPDATE thread_index SET kind = 'feedback' WHERE id = ?")
      .bind(threadId)
      .run();

    await expect(reconcileThreadSearchProjection(env, threadId)).resolves.toBe("skipped");
    await expect(projectionRows(threadId)).resolves.toEqual([]);
    await expect(threadMeta(threadId)).resolves.toEqual({
      updatedAt: 200,
      lastMessagePreview: "",
      searchIndexedThrough: null,
    });
  });
});

async function scheduleAndWait(threadId: string, source: ActiveTranscriptRpc): Promise<void> {
  const promises: Promise<unknown>[] = [];
  scheduleLocalThreadSearchProjection({
    env,
    threadId,
    waitUntil: (promise) => promises.push(promise),
    source: async () => source,
  });
  expect(promises).toHaveLength(1);
  await promises[0];
}

async function reconcileThreadSearchProjectionFromSource(
  threadId: string,
  source: ActiveTranscriptRpc,
): Promise<void> {
  const promises: Promise<unknown>[] = [];
  scheduleLocalThreadSearchProjection({
    env,
    threadId,
    waitUntil: (promise) => promises.push(promise),
    source: async () => source,
  });
  expect(promises).toHaveLength(1);
  await promises[0];
}
