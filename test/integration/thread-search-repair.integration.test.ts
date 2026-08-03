import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../../src/db/schema";
import { registryDb } from "../../src/db/client";
import { ArchivedMessageRepository } from "../../src/db/repositories/archived-messages";
import { ThreadSearchProjectionRepository } from "../../src/db/repositories/thread-search-projection";
import { AUTO_ARCHIVE_CRON, AUTOMATA_CRON } from "../../src/automata/fire-due";
import type {
  ActiveTranscriptRpc,
  InternalGrepRequest,
  InternalGrepResult,
  InternalReadRequest,
  InternalReadResult,
  ThreadSearchDocument,
} from "../../src/thread-knowledge/types";
import { normalizeProseMessage } from "../../src/thread-knowledge/prose-normalizer";
import { THREAD_LAST_MESSAGE_PREVIEW_CHARS } from "../../src/thread-knowledge/types";
import { applyRegistryTestSchema } from "./helpers/registry";
import { resetRegistryState } from "./helpers/reset";

const { activeTranscriptRpcMock, logInfoMock } = vi.hoisted(() => ({
  activeTranscriptRpcMock: vi.fn(),
  logInfoMock: vi.fn(),
}));

vi.mock("../../src/thread-knowledge/adapters/active-transcript", () => ({
  activeTranscriptRpc: activeTranscriptRpcMock,
}));

vi.mock("../../src/log", () => ({
  log: {
    debug: vi.fn(),
    info: logInfoMock,
    warn: vi.fn(),
    error: vi.fn(),
  },
  setLogLevel: vi.fn(),
}));

const baseTime = 1_800_000_000_000;

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

function sourceHash(raw: unknown): string {
  return `source:${JSON.stringify(raw)}`;
}

function makeSource(messages: unknown[]): ActiveTranscriptRpc {
  const byId = new Map(
    messages
      .filter((raw): raw is { id: string } => typeof raw === "object" && raw !== null)
      .filter((raw) => typeof raw.id === "string")
      .map((raw) => [raw.id, raw]),
  );
  return {
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
      const digests = page.map((raw, index) => {
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
              : `raw:${start + index}`,
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
      return messageIds.flatMap((messageId) => {
        const raw = byId.get(messageId);
        const normalized = normalizeProseMessage(raw);
        if (normalized.message === null) return [];
        return [{ message: normalized.message, sourceHash: sourceHash(raw) }];
      });
    },
  };
}

async function seedWorkspace(workspaceId: string) {
  await env.REGISTRY_DB.prepare("INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)")
    .bind(workspaceId, workspaceId, baseTime)
    .run();
  await env.REGISTRY_DB.prepare(
    "INSERT INTO agents (id, workspace_id, name, system_prompt, provider, model, created_at) VALUES (?, ?, 'Default', 'You are Nadi.', 'mock', 'mock', ?)",
  )
    .bind(`agent-${workspaceId}`, workspaceId, baseTime)
    .run();
  return { workspaceId, agentId: `agent-${workspaceId}` };
}

async function insertThread(input: {
  id: string;
  workspaceId: string;
  agentId: string;
  runtime?: "legacy" | "think";
  kind?: "regular" | "feedback";
  archivedAt?: number | null;
  updatedAt: number;
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
      input.id,
      input.runtime ?? "think",
      input.kind ?? "regular",
      input.archivedAt ?? null,
      input.searchIndexedThrough ?? null,
      baseTime,
      input.updatedAt,
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

async function repairAttempts(threadId: string) {
  const row = await env.REGISTRY_DB.prepare(
    "SELECT search_repair_attempts AS attempts FROM thread_index WHERE id = ?",
  )
    .bind(threadId)
    .first<{ attempts: number | null }>();
  return row?.attempts ?? null;
}

async function threadCheckpoint(threadId: string) {
  const row = await env.REGISTRY_DB.prepare(
    "SELECT search_indexed_through AS searchIndexedThrough FROM thread_index WHERE id = ?",
  )
    .bind(threadId)
    .first<{ searchIndexedThrough: number | null }>();
  return row?.searchIndexedThrough ?? null;
}

describe("thread search stale projection repair", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await resetRegistryState(env.REGISTRY_DB);
  });

  it("selects oldest stale non-feedback threads and repairs active and archived sources", async () => {
    const workspace = await seedWorkspace("ws_repair_order");
    await insertThread({
      id: "thr_repair_current",
      ...workspace,
      updatedAt: baseTime + 5,
      searchIndexedThrough: baseTime + 5,
    });
    await insertThread({
      id: "thr_repair_feedback",
      ...workspace,
      kind: "feedback",
      updatedAt: baseTime + 10,
      searchIndexedThrough: null,
    });
    await insertThread({
      id: "thr_repair_active_old",
      ...workspace,
      runtime: "think",
      updatedAt: baseTime + 20,
      searchIndexedThrough: null,
    });
    await insertThread({
      id: "thr_repair_archived",
      ...workspace,
      archivedAt: baseTime + 40,
      updatedAt: baseTime + 30,
      searchIndexedThrough: baseTime + 1,
    });
    await insertThread({
      id: "thr_repair_active_new",
      ...workspace,
      runtime: "think",
      updatedAt: baseTime + 50,
      searchIndexedThrough: null,
    });

    activeTranscriptRpcMock.mockImplementation(async (_envArg, thread: { id: string }) => {
      if (thread.id === "thr_repair_active_old") {
        return makeSource([message({ id: "active-old", text: "active old repairtoken" })]);
      }
      if (thread.id === "thr_repair_active_new") {
        return makeSource([message({ id: "active-new", text: "active new repairtoken" })]);
      }
      throw new Error(`unexpected active repair ${thread.id}`);
    });
    await new ArchivedMessageRepository(drizzle(env.REGISTRY_DB, { schema })).replaceForThread(
      "thr_repair_archived",
      [message({ id: "archived-repair", text: "archived repairtoken" })],
    );

    const { repairStaleThreadSearchProjections } =
      await import("../../src/thread-knowledge/repair");
    const projection = new ThreadSearchProjectionRepository(env.REGISTRY_DB);

    await expect(projection.selectStaleThreads(10)).resolves.toEqual([
      expect.objectContaining({ id: "thr_repair_active_old" }),
      expect.objectContaining({ id: "thr_repair_archived" }),
      expect.objectContaining({ id: "thr_repair_active_new" }),
    ]);
    await expect(repairStaleThreadSearchProjections(env)).resolves.toEqual({
      selected: 3,
      succeeded: 3,
      failed: 0,
      remaining: 0,
    });
    expect(activeTranscriptRpcMock).toHaveBeenCalledTimes(2);
    expect(activeTranscriptRpcMock.mock.calls.map((call) => call[1].id)).toEqual([
      "thr_repair_active_old",
      "thr_repair_active_new",
    ]);
    await expect(projectionRows("thr_repair_active_old")).resolves.toEqual([
      {
        messageId: "active-old",
        content: "active old repairtoken",
        indexedRevision: baseTime + 20,
      },
    ]);
    await expect(projectionRows("thr_repair_archived")).resolves.toEqual([
      {
        messageId: "archived-repair",
        content: "archived repairtoken",
        indexedRevision: baseTime + 30,
      },
    ]);
  });

  // Regression: gating the DO read on the runtime made an unarchived `legacy` row
  // return "skipped" without advancing its checkpoint, so it stayed stale and
  // re-occupied the oldest-first batch on every subsequent run. It must DRAIN —
  // via the D1 archive source, which is where such a thread's transcript lives.
  it("drains a retired-runtime thread from D1 instead of starving the batch", async () => {
    const workspace = await seedWorkspace("ws_repair_retired");
    await insertThread({
      id: "thr_repair_retired",
      ...workspace,
      runtime: "legacy",
      updatedAt: baseTime + 20,
      searchIndexedThrough: null,
    });
    await new ArchivedMessageRepository(drizzle(env.REGISTRY_DB, { schema })).replaceForThread(
      "thr_repair_retired",
      [message({ id: "retired-repair", text: "retired repairtoken" })],
    );
    activeTranscriptRpcMock.mockImplementation(async () => {
      throw new Error("retired-runtime thread must not dial a Durable Object");
    });

    const { repairStaleThreadSearchProjections } =
      await import("../../src/thread-knowledge/repair");

    await expect(repairStaleThreadSearchProjections(env)).resolves.toEqual({
      selected: 1,
      succeeded: 1,
      failed: 0,
      remaining: 0,
    });
    expect(activeTranscriptRpcMock).not.toHaveBeenCalled();
    await expect(projectionRows("thr_repair_retired")).resolves.toEqual([
      {
        messageId: "retired-repair",
        content: "retired repairtoken",
        indexedRevision: baseTime + 20,
      },
    ]);
  });

  it("counts failures and continues repairing later rows", async () => {
    const workspace = await seedWorkspace("ws_repair_failure");
    await insertThread({
      id: "thr_repair_fail",
      ...workspace,
      updatedAt: baseTime + 10,
      searchIndexedThrough: null,
    });
    await insertThread({
      id: "thr_repair_after_archive",
      ...workspace,
      archivedAt: baseTime + 15,
      updatedAt: baseTime + 20,
      searchIndexedThrough: null,
    });
    await insertThread({
      id: "thr_repair_after_active",
      ...workspace,
      updatedAt: baseTime + 30,
      searchIndexedThrough: null,
    });
    activeTranscriptRpcMock.mockImplementation(async (_envArg, thread: { id: string }) => {
      if (thread.id === "thr_repair_fail") throw new Error("active source unavailable");
      return makeSource([message({ id: "after-active", text: "after active repair" })]);
    });
    await new ArchivedMessageRepository(drizzle(env.REGISTRY_DB, { schema })).replaceForThread(
      "thr_repair_after_archive",
      [message({ id: "after-archive", text: "after archive repair" })],
    );

    const { repairStaleThreadSearchProjections } =
      await import("../../src/thread-knowledge/repair");

    await expect(repairStaleThreadSearchProjections(env)).resolves.toEqual({
      selected: 3,
      succeeded: 2,
      failed: 1,
      remaining: 1,
    });
    await expect(threadCheckpoint("thr_repair_fail")).resolves.toBeNull();
    await expect(projectionRows("thr_repair_after_archive")).resolves.toHaveLength(1);
    await expect(projectionRows("thr_repair_after_active")).resolves.toHaveLength(1);
  });

  it("repairs at most ten stale rows per batch", async () => {
    const workspace = await seedWorkspace("ws_repair_batch");
    for (let index = 0; index < 11; index += 1) {
      await insertThread({
        id: `thr_repair_batch_${index}`,
        ...workspace,
        updatedAt: baseTime + index,
        searchIndexedThrough: null,
      });
    }
    activeTranscriptRpcMock.mockImplementation(async (_envArg, thread: { id: string }) =>
      makeSource([message({ id: `msg-${thread.id}`, text: `batch repair ${thread.id}` })]),
    );

    const { repairStaleThreadSearchProjections } =
      await import("../../src/thread-knowledge/repair");

    await expect(repairStaleThreadSearchProjections(env)).resolves.toEqual({
      selected: 10,
      succeeded: 10,
      failed: 0,
      remaining: 1,
    });
    await expect(projectionRows("thr_repair_batch_9")).resolves.toHaveLength(1);
    await expect(projectionRows("thr_repair_batch_10")).resolves.toEqual([]);
  });

  it("runs daily repair after auto-archive on the non-Automata scheduled branch and logs the result", async () => {
    const workspace = await seedWorkspace("ws_repair_scheduled");
    await insertThread({
      id: "thr_repair_scheduled",
      ...workspace,
      updatedAt: Date.now(),
      searchIndexedThrough: null,
    });
    activeTranscriptRpcMock.mockResolvedValue(
      makeSource([message({ id: "scheduled-repair", text: "scheduled repairtoken" })]),
    );
    const worker = (await import("../../src/index")).default;

    await worker.scheduled!(
      { cron: AUTO_ARCHIVE_CRON, scheduledTime: Date.now() } as ScheduledController,
      env,
    );
    await worker.scheduled!(
      { cron: AUTOMATA_CRON, scheduledTime: Date.now() } as ScheduledController,
      env,
    );

    await expect(projectionRows("thr_repair_scheduled")).resolves.toEqual([
      {
        messageId: "scheduled-repair",
        content: "scheduled repairtoken",
        indexedRevision: expect.any(Number),
      },
    ]);
    expect(logInfoMock).toHaveBeenCalledWith("worker.scheduled.thread_search_repair", {
      selected: 1,
      succeeded: 1,
      failed: 0,
      remaining: 0,
    });
    expect(logInfoMock).not.toHaveBeenCalledWith(
      "worker.scheduled.thread_search_repair",
      expect.objectContaining({ selected: 0 }),
    );
  });

  it("rotates a permanently failing thread behind healthy peers instead of wedging the batch", async () => {
    const workspace = await seedWorkspace("ws_repair_rotation");
    // Oldest-first ordering puts the broken thread at the head of the queue.
    // With a batch of one, an unrotated failure would be re-selected forever and
    // neither healthy thread would ever be indexed.
    await insertThread({
      id: "thr_rotation_broken",
      ...workspace,
      runtime: "think",
      updatedAt: baseTime + 10,
      searchIndexedThrough: null,
    });
    await insertThread({
      id: "thr_rotation_healthy_a",
      ...workspace,
      runtime: "think",
      updatedAt: baseTime + 20,
      searchIndexedThrough: null,
    });
    await insertThread({
      id: "thr_rotation_healthy_b",
      ...workspace,
      runtime: "think",
      updatedAt: baseTime + 30,
      searchIndexedThrough: null,
    });
    activeTranscriptRpcMock.mockImplementation(async (_envArg, thread: { id: string }) => {
      if (thread.id === "thr_rotation_broken") throw new Error("permanently broken source");
      return makeSource([message({ id: `msg-${thread.id}`, text: `rotation ${thread.id}` })]);
    });

    const { repairStaleThreadSearchProjections } =
      await import("../../src/thread-knowledge/repair");

    await expect(repairStaleThreadSearchProjections(env, 1)).resolves.toEqual({
      selected: 1,
      succeeded: 0,
      failed: 1,
      remaining: 3,
    });
    await expect(repairAttempts("thr_rotation_broken")).resolves.toBe(1);

    // The next two runs must make progress on the healthy threads rather than
    // re-picking the broken one.
    await expect(repairStaleThreadSearchProjections(env, 1)).resolves.toEqual({
      selected: 1,
      succeeded: 1,
      failed: 0,
      remaining: 2,
    });
    await expect(projectionRows("thr_rotation_healthy_a")).resolves.toHaveLength(1);

    await expect(repairStaleThreadSearchProjections(env, 1)).resolves.toEqual({
      selected: 1,
      succeeded: 1,
      failed: 0,
      remaining: 1,
    });
    await expect(projectionRows("thr_rotation_healthy_b")).resolves.toHaveLength(1);

    // Only the broken thread is left, so it is retried — rotation defers a
    // failure, it never abandons it.
    await expect(repairStaleThreadSearchProjections(env, 1)).resolves.toEqual({
      selected: 1,
      succeeded: 0,
      failed: 1,
      remaining: 1,
    });
    await expect(repairAttempts("thr_rotation_broken")).resolves.toBe(2);
    await expect(threadCheckpoint("thr_rotation_broken")).resolves.toBeNull();
  });

  it("clears the failure count once a thread repairs successfully", async () => {
    const workspace = await seedWorkspace("ws_repair_recovery");
    await insertThread({
      id: "thr_recovery",
      ...workspace,
      runtime: "think",
      updatedAt: baseTime + 10,
      searchIndexedThrough: null,
    });
    let healthy = false;
    activeTranscriptRpcMock.mockImplementation(async (_envArg, thread: { id: string }) => {
      if (!healthy) throw new Error("transient source failure");
      return makeSource([message({ id: `msg-${thread.id}`, text: "recovered" })]);
    });

    const { repairStaleThreadSearchProjections } =
      await import("../../src/thread-knowledge/repair");

    await repairStaleThreadSearchProjections(env, 1);
    await expect(repairAttempts("thr_recovery")).resolves.toBe(1);

    healthy = true;
    await expect(repairStaleThreadSearchProjections(env, 1)).resolves.toEqual({
      selected: 1,
      succeeded: 1,
      failed: 0,
      remaining: 0,
    });
    await expect(repairAttempts("thr_recovery")).resolves.toBeNull();
  });

  it("honours a caller-supplied batch size and caps it", async () => {
    const workspace = await seedWorkspace("ws_repair_limit");
    for (let index = 0; index < 12; index += 1) {
      await insertThread({
        id: `thr_limit_${index}`,
        ...workspace,
        runtime: "think",
        updatedAt: baseTime + index,
        searchIndexedThrough: null,
      });
    }
    activeTranscriptRpcMock.mockImplementation(async (_envArg, thread: { id: string }) =>
      makeSource([message({ id: `msg-${thread.id}`, text: `limit ${thread.id}` })]),
    );

    const { repairStaleThreadSearchProjections, SEARCH_REPAIR_MAX_BATCH } =
      await import("../../src/thread-knowledge/repair");

    // Above the default batch of ten, proving the limit is what bounds the run.
    await expect(repairStaleThreadSearchProjections(env, 12)).resolves.toEqual({
      selected: 12,
      succeeded: 12,
      failed: 0,
      remaining: 0,
    });
    expect(SEARCH_REPAIR_MAX_BATCH).toBe(200);
  });
});
