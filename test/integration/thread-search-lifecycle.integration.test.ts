import { SELF, env, runInDurableObject } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../../src/db/schema";
import { registryDb } from "../../src/db/client";
import { ThreadKnowledgeService } from "../../src/thread-knowledge/service";
import type { SearchThreadsResult, ThreadKnowledgeResult } from "../../src/thread-knowledge/types";
import { archiveThreadCore } from "../../src/agent/archive-thread";
import { routeThreads } from "../../src/http/thread-routes";
import { applyRegistryTestSchema } from "./helpers/registry";
import { resetRegistryState } from "./helpers/reset";

const runInThinkDo = runInDurableObject as any;
const baseTime = 1_800_000_000_000;

function cookie(token: string) {
  return { cookie: `better-auth.session_token=${token}` };
}

function expectOk<T extends object>(result: ThreadKnowledgeResult<T>): T {
  if (isThreadKnowledgeError(result)) {
    throw new Error(`${result.code}: ${result.message}`);
  }
  return result;
}

function isThreadKnowledgeError(
  result: unknown,
): result is { ok: false; code: string; message: string } {
  return typeof result === "object" && result !== null && "ok" in result && result.ok === false;
}

function serviceFor(workspaceId: string) {
  return new ThreadKnowledgeService({
    env,
    db: registryDb(env),
    binding: env.REGISTRY_DB,
    scope: { workspaceId, callerThreadId: "caller-thread" },
  });
}

function message(input: {
  id: string;
  role?: "user" | "assistant";
  text: string;
  createdAt?: number;
}) {
  return {
    id: input.id,
    role: input.role ?? "user",
    createdAt: input.createdAt ?? baseTime,
    parts: [{ type: "text", text: input.text }],
  };
}

async function seedUserWorkspace(input?: {
  userId?: string;
  token?: string;
  workspaceId?: string;
}) {
  const db = drizzle(env.REGISTRY_DB, { schema });
  const userId = input?.userId ?? "usr_lifecycle";
  const token = input?.token ?? "token-lifecycle";
  const workspaceId = input?.workspaceId ?? "ws_lifecycle";
  const agentId = `agent-${workspaceId}`;

  await db.insert(schema.users).values({
    id: userId,
    email: `${userId}@example.com`,
    name: null,
    emailVerified: true,
    image: null,
    createdAt: new Date(baseTime),
    updatedAt: new Date(baseTime),
  });
  await db.insert(schema.sessions).values({
    id: `session-${userId}`,
    userId,
    token,
    expiresAt: new Date(baseTime + 60_000),
    createdAt: new Date(baseTime),
    updatedAt: new Date(baseTime),
    ipAddress: null,
    userAgent: null,
  });
  await db
    .insert(schema.workspaces)
    .values({ id: workspaceId, name: workspaceId, createdAt: baseTime });
  await db
    .insert(schema.workspaceMembers)
    .values({ workspaceId, userId, role: "owner", createdAt: baseTime });
  await db.insert(schema.agents).values({
    id: agentId,
    workspaceId,
    name: "Default",
    systemPrompt: "You are Nadi.",
    provider: "mock",
    model: "mock",
    createdAt: baseTime,
  });

  return { userId, token, workspaceId, agentId };
}

async function insertThread(input: {
  id: string;
  workspaceId: string;
  agentId: string;
  title?: string;
  runtime?: "legacy" | "think";
  kind?: "regular" | "feedback";
  archivedAt?: number | null;
  updatedAt?: number;
  searchIndexedThrough?: number | null;
}) {
  await env.REGISTRY_DB.prepare(
    `
      INSERT INTO thread_index (
        id, workspace_id, agent_id, title, title_set, runtime, source,
        automaton_id, automaton_run_id, last_event_id, last_message_preview,
        kind, archived_at, search_indexed_through, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, 1, ?, 'manual', NULL, NULL, NULL, '', ?, ?, ?, ?, ?)
    `,
  )
    .bind(
      input.id,
      input.workspaceId,
      input.agentId,
      input.title ?? input.id,
      input.runtime ?? "legacy",
      input.kind ?? "regular",
      input.archivedAt ?? null,
      input.searchIndexedThrough ?? null,
      baseTime,
      input.updatedAt ?? baseTime,
    )
    .run();
}

async function insertSearchMessage(input: {
  workspaceId: string;
  threadId: string;
  messageId: string;
  content: string;
  indexedRevision?: number;
}) {
  await env.REGISTRY_DB.prepare(
    `
      INSERT INTO thread_search_messages (
        workspace_id, thread_id, message_id, role, created_at, content,
        content_hash, source_hash, indexed_revision
      )
      VALUES (?, ?, ?, 'user', ?, ?, ?, ?, ?)
    `,
  )
    .bind(
      input.workspaceId,
      input.threadId,
      input.messageId,
      baseTime,
      input.content,
      `content-${input.messageId}`,
      `source-${input.messageId}`,
      input.indexedRevision ?? baseTime,
    )
    .run();
}

async function projectionRows(threadId: string) {
  const rows = await env.REGISTRY_DB.prepare(
    "SELECT message_id AS messageId, content, indexed_revision AS indexedRevision FROM thread_search_messages WHERE thread_id = ? ORDER BY message_id",
  )
    .bind(threadId)
    .all<{ messageId: string; content: string; indexedRevision: number }>();
  return rows.results;
}

async function threadMeta(threadId: string) {
  return env.REGISTRY_DB.prepare(
    "SELECT archived_at AS archivedAt, search_indexed_through AS searchIndexedThrough FROM thread_index WHERE id = ?",
  )
    .bind(threadId)
    .first<{ archivedAt: number | null; searchIndexedThrough: number | null }>();
}

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

async function addThinkMessages(threadId: string, messages: unknown[]) {
  const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));
  await runInThinkDo(stub, async (instance: any) => {
    await instance.__unsafe_ensureInitialized();
    await instance.addMessages(messages);
    await instance.ctx.storage.put("archive_destroy_sentinel", "present");
  });
}

describe("thread search archive/delete lifecycle", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  beforeEach(async () => {
    await resetRegistryState(env.REGISTRY_DB);
  });

  it("archives from one raw snapshot, refreshes search, and destroys the durable object", async () => {
    const seeded = await seedUserWorkspace();
    const threadId = "thr_lifecycle_archive";
    await insertThread({
      id: threadId,
      workspaceId: seeded.workspaceId,
      agentId: seeded.agentId,
      runtime: "think",
      updatedAt: baseTime + 200,
      searchIndexedThrough: baseTime + 999,
    });
    await insertSearchMessage({
      workspaceId: seeded.workspaceId,
      threadId,
      messageId: "stale-message",
      content: "stale lifecycle row",
      indexedRevision: baseTime + 100,
    });
    await addThinkMessages(threadId, [
      message({ id: "archive-user", text: "archivecycle question", createdAt: baseTime + 1 }),
      message({
        id: "archive-assistant",
        role: "assistant",
        text: "archivecycle answer",
        createdAt: baseTime + 2,
      }),
    ]);

    await expect(archiveThreadCore(env, threadId)).resolves.toBe("archived");

    await expect(projectionRows(threadId)).resolves.toEqual([
      {
        messageId: "archive-assistant",
        content: "archivecycle answer",
        indexedRevision: baseTime + 200,
      },
      {
        messageId: "archive-user",
        content: "archivecycle question",
        indexedRevision: baseTime + 200,
      },
    ]);
    await expect(threadMeta(threadId)).resolves.toMatchObject({
      archivedAt: expect.any(Number),
      searchIndexedThrough: baseTime + 200,
    });
    const search = expectOk<SearchThreadsResult>(
      await serviceFor(seeded.workspaceId).searchThreads({
        query: "archivecycle",
        status: "archived",
      }),
    );
    expect(search.results.map((item) => item.thread.id)).toEqual([threadId]);
    await expect(matchingMessageIds("stale")).resolves.toEqual([]);

    const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));
    await expect(
      runInThinkDo(stub, (instance: any) => instance.ctx.storage.get("archive_destroy_sentinel")),
    ).rejects.toThrow("destroyed");
  });

  it("continues archive when projection refresh fails and leaves the checkpoint invalidated", async () => {
    const seeded = await seedUserWorkspace({ workspaceId: "ws_lifecycle_failure" });
    const threadId = "thr_lifecycle_projection_failure";
    await insertThread({
      id: threadId,
      workspaceId: seeded.workspaceId,
      agentId: seeded.agentId,
      runtime: "think",
      updatedAt: baseTime + 300,
      searchIndexedThrough: baseTime + 999,
    });
    await addThinkMessages(threadId, [
      message({ id: "failure-user", text: "projection failure should not block archive" }),
    ]);

    const failingBinding = new Proxy(env.REGISTRY_DB, {
      get(target, property, receiver) {
        if (property !== "prepare") {
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (sql: string) => {
          if (sql.includes("thread_search_messages")) {
            throw new Error("simulated projection outage");
          }
          return target.prepare(sql);
        };
      },
    }) as D1Database;

    await expect(
      archiveThreadCore({ ...env, REGISTRY_DB: failingBinding } as typeof env, threadId),
    ).resolves.toBe("archived");
    await expect(threadMeta(threadId)).resolves.toMatchObject({
      archivedAt: expect.any(Number),
      searchIndexedThrough: null,
    });
  });

  it("clears projection rows before deleting a thread row", async () => {
    const seeded = await seedUserWorkspace({ workspaceId: "ws_lifecycle_delete" });
    const threadId = "thr_lifecycle_delete";
    await insertThread({
      id: threadId,
      workspaceId: seeded.workspaceId,
      agentId: seeded.agentId,
      archivedAt: baseTime + 500,
      searchIndexedThrough: baseTime + 100,
    });
    await insertSearchMessage({
      workspaceId: seeded.workspaceId,
      threadId,
      messageId: "delete-message",
      content: "deletelifecycle searchable row",
    });

    const operations: string[] = [];
    const observingBinding = new Proxy(env.REGISTRY_DB, {
      get(target, property, receiver) {
        if (property !== "prepare") {
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (sql: string) => {
          if (/DELETE\s+FROM\s+thread_search_messages/i.test(sql)) operations.push("projection");
          if (/DELETE\s+FROM\s+["`]?thread_index/i.test(sql)) operations.push("thread");
          return target.prepare(sql);
        };
      },
    }) as D1Database;

    const response = await routeThreads(
      new Request(`https://nadi.test/api/threads/${threadId}`, {
        method: "DELETE",
        headers: cookie(seeded.token),
      }),
      { ...env, REGISTRY_DB: observingBinding } as typeof env,
      { waitUntil() {} } as unknown as ExecutionContext,
    );

    expect(response?.status).toBe(204);
    expect(operations.slice(-2)).toEqual(["projection", "thread"]);
    await expect(projectionRows(threadId)).resolves.toEqual([]);
    await expect(matchingMessageIds("deletelifecycle")).resolves.toEqual([]);
  });

  it("keeps feedback threads out of search even if archive/delete lifecycle rows exist", async () => {
    const seeded = await seedUserWorkspace({ workspaceId: "ws_lifecycle_feedback" });
    await insertThread({
      id: "thr_lifecycle_feedback",
      workspaceId: seeded.workspaceId,
      agentId: seeded.agentId,
      kind: "feedback",
      archivedAt: baseTime + 1,
      searchIndexedThrough: baseTime,
    });
    await insertSearchMessage({
      workspaceId: seeded.workspaceId,
      threadId: "thr_lifecycle_feedback",
      messageId: "feedback-message",
      content: "feedbacklifecycle should stay hidden",
    });

    const search = expectOk<SearchThreadsResult>(
      await serviceFor(seeded.workspaceId).searchThreads({
        query: "feedbacklifecycle",
        status: "all",
      }),
    );
    expect(search.results).toEqual([]);

    const response = await SELF.fetch("https://nadi.test/api/threads/thr_lifecycle_feedback", {
      method: "DELETE",
      headers: cookie(seeded.token),
    });
    expect(response.status).toBe(404);
  });
});
