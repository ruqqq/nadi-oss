import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registryDb } from "../../src/db/client";
import * as schema from "../../src/db/schema";
import { ArchivedMessageRepository } from "../../src/db/repositories/archived-messages";
import { ThreadKnowledgeService } from "../../src/thread-knowledge/service";
import type {
  ActiveTranscriptRpc,
  GrepThreadResult,
  ListThreadsResult,
  ReadThreadResult,
  SearchThreadsResult,
  ThreadKnowledgeError,
  ThreadKnowledgeResult,
} from "../../src/thread-knowledge/types";
import { applyRegistryTestSchema } from "./helpers/registry";
import { resetRegistryState } from "./helpers/reset";

const { activeTranscriptRpcMock } = vi.hoisted(() => ({
  activeTranscriptRpcMock: vi.fn(),
}));

vi.mock("../../src/thread-knowledge/adapters/active-transcript", () => ({
  activeTranscriptRpc: activeTranscriptRpcMock,
}));

const baseTime = 1_800_000_000_000;

function isThreadKnowledgeError(result: unknown): result is ThreadKnowledgeError {
  return typeof result === "object" && result !== null && "ok" in result && result.ok === false;
}

function expectOk<T extends object>(result: ThreadKnowledgeResult<T>): T {
  if (isThreadKnowledgeError(result)) {
    throw new Error(`${result.code}: ${result.message}`);
  }
  return result;
}

function expectError<T extends object>(result: ThreadKnowledgeResult<T>): ThreadKnowledgeError {
  if (!isThreadKnowledgeError(result)) {
    throw new Error("expected structured thread knowledge error");
  }
  return result;
}

function message(input: {
  id: string;
  role?: "user" | "assistant";
  text: string;
  createdAt?: string | number | null;
}) {
  return {
    id: input.id,
    role: input.role ?? "user",
    createdAt: input.createdAt,
    parts: [{ type: "text", text: input.text }],
  };
}

function serviceFor(workspaceId: string, binding: D1Database = env.REGISTRY_DB) {
  return new ThreadKnowledgeService({
    env,
    db: registryDb(env),
    binding,
    scope: { workspaceId, callerThreadId: "caller-thread" },
  });
}

async function insertWorkspace(input: { workspaceId: string; agentIds: string[] }) {
  await env.REGISTRY_DB.prepare("INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)")
    .bind(input.workspaceId, input.workspaceId, baseTime)
    .run();
  for (const agentId of input.agentIds) {
    await env.REGISTRY_DB.prepare(
      "INSERT INTO agents (id, workspace_id, name, system_prompt, provider, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(agentId, input.workspaceId, agentId, "You are Nadi.", "mock", "mock", baseTime)
      .run();
  }
}

async function insertProject(input: { id: string; workspaceId: string; name: string }) {
  await env.REGISTRY_DB.prepare(
    "INSERT INTO projects (id, workspace_id, name, description, custom_instructions, created_at, updated_at) VALUES (?, ?, ?, '', '', ?, ?)",
  )
    .bind(input.id, input.workspaceId, input.name, baseTime, baseTime)
    .run();
}

async function insertThread(input: {
  id: string;
  workspaceId: string;
  agentId: string;
  title: string;
  projectId?: string | null;
  preview?: string;
  kind?: "regular" | "feedback";
  source?: "manual" | "automaton";
  runtime?: "legacy" | "think";
  createdAt?: number;
  updatedAt?: number;
  archivedAt?: number | null;
  searchIndexedThrough?: number | null;
}) {
  await env.REGISTRY_DB.prepare(
    `
      INSERT INTO thread_index (
        id,
        workspace_id,
        agent_id,
        project_id,
        title,
        title_set,
        runtime,
        source,
        automaton_id,
        automaton_run_id,
        last_event_id,
        last_message_preview,
        kind,
        archived_at,
        search_indexed_through,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
    `,
  )
    .bind(
      input.id,
      input.workspaceId,
      input.agentId,
      input.projectId ?? null,
      input.title,
      input.runtime ?? "think",
      input.source ?? "manual",
      input.source === "automaton" ? `automaton-${input.id}` : null,
      input.source === "automaton" ? `run-${input.id}` : null,
      input.preview ?? "",
      input.kind ?? "regular",
      input.archivedAt ?? null,
      input.searchIndexedThrough ?? null,
      input.createdAt ?? baseTime,
      input.updatedAt ?? baseTime,
    )
    .run();
}

async function insertSearchMessage(input: {
  threadId: string;
  workspaceId: string;
  messageId: string;
  role?: "user" | "assistant";
  createdAt?: number | null;
  content: string;
}) {
  await env.REGISTRY_DB.prepare(
    `
      INSERT INTO thread_search_messages (
        workspace_id,
        thread_id,
        message_id,
        role,
        created_at,
        content,
        content_hash,
        source_hash,
        indexed_revision
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  )
    .bind(
      input.workspaceId,
      input.threadId,
      input.messageId,
      input.role ?? "user",
      input.createdAt ?? null,
      input.content,
      `content-${input.messageId}`,
      `source-${input.messageId}`,
      1,
    )
    .run();
}

async function seedKnowledgeFixtures() {
  const workspaceId = "workspace-knowledge";
  const foreignWorkspaceId = "workspace-foreign";
  const projectNeedle = "project-needle";
  const projectArchive = "project-archive";
  const activeA = "thread_active_a";
  const activeB = "thread_active_b";
  const archived = "thread_archived";
  const old = "thread_old";
  const automaton = "thread_automaton";
  const feedback = "thread_feedback";
  const foreign = "thread_foreign";

  await insertWorkspace({ workspaceId, agentIds: ["agent-a", "agent-b"] });
  await insertWorkspace({ workspaceId: foreignWorkspaceId, agentIds: ["agent-foreign"] });
  await insertProject({ id: projectNeedle, workspaceId, name: "Needle Project" });
  await insertProject({ id: projectArchive, workspaceId, name: "Archive Project" });
  await insertProject({
    id: "project-foreign",
    workspaceId: foreignWorkspaceId,
    name: "Needle Project",
  });

  await insertThread({
    id: activeA,
    workspaceId,
    agentId: "agent-a",
    projectId: projectNeedle,
    title: "Needle launch notes",
    preview: "needle preview from active thread",
    updatedAt: baseTime + 30_000,
    searchIndexedThrough: baseTime + 30_000,
  });
  await insertThread({
    id: activeB,
    workspaceId,
    agentId: "agent-b",
    projectId: projectArchive,
    title: "Unmatched backlog",
    preview: "ordinary preview",
    updatedAt: baseTime + 30_000,
    searchIndexedThrough: baseTime + 1,
  });
  await insertThread({
    id: archived,
    workspaceId,
    agentId: "agent-a",
    projectId: projectArchive,
    title: "Archived needle context",
    preview: "archive preview",
    updatedAt: baseTime + 20_000,
    archivedAt: baseTime + 40_000,
    searchIndexedThrough: baseTime + 20_000,
  });
  await insertThread({
    id: old,
    workspaceId,
    agentId: "agent-b",
    projectId: projectArchive,
    title: "Old visible thread",
    preview: "old preview",
    updatedAt: baseTime - 1_000,
    searchIndexedThrough: baseTime - 1_000,
  });
  await insertThread({
    id: automaton,
    workspaceId,
    agentId: "agent-a",
    title: "Automaton needle digest",
    source: "automaton",
    updatedAt: baseTime + 50_000,
    searchIndexedThrough: baseTime + 50_000,
  });
  await insertThread({
    id: feedback,
    workspaceId,
    agentId: "agent-a",
    title: "Feedback needle thread",
    kind: "feedback",
    updatedAt: baseTime + 60_000,
    searchIndexedThrough: baseTime + 60_000,
  });
  await insertThread({
    id: foreign,
    workspaceId: foreignWorkspaceId,
    agentId: "agent-foreign",
    projectId: "project-foreign",
    title: "Foreign needle launch notes",
    preview: "foreign preview",
    updatedAt: baseTime + 70_000,
    searchIndexedThrough: baseTime + 70_000,
  });

  await insertSearchMessage({
    workspaceId,
    threadId: activeA,
    messageId: "msg-active-needle",
    role: "assistant",
    createdAt: baseTime + 10_000,
    content: "The launch needle appears in the transcript.",
  });
  await insertSearchMessage({
    workspaceId,
    threadId: archived,
    messageId: "msg-archived-needle",
    role: "user",
    createdAt: baseTime + 11_000,
    content: "Archived needle evidence should also rank.",
  });
  await insertSearchMessage({
    workspaceId,
    threadId: automaton,
    messageId: "msg-automaton-needle",
    createdAt: baseTime + 12_000,
    content: "Automaton needle evidence is opt-in.",
  });
  await insertSearchMessage({
    workspaceId: foreignWorkspaceId,
    threadId: foreign,
    messageId: "msg-foreign-needle",
    createdAt: baseTime + 13_000,
    content: "Foreign needle evidence must stay hidden.",
  });

  await new ArchivedMessageRepository(drizzle(env.REGISTRY_DB, { schema })).replaceForThread(
    archived,
    [
      message({
        id: "archived-user",
        text: "archived source needle line",
        createdAt: "2026-07-10T00:00:00.000Z",
      }),
      message({
        id: "archived-assistant",
        role: "assistant",
        text: "archived assistant context",
        createdAt: "2026-07-11T00:00:00.000Z",
      }),
    ],
  );

  return {
    workspaceId,
    foreignWorkspaceId,
    projectNeedle,
    projectArchive,
    ids: { activeA, activeB, archived, old, automaton, feedback, foreign },
  };
}

describe("ThreadKnowledgeService list_threads", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await resetRegistryState(env.REGISTRY_DB);
  });

  it("lists all visible workspace threads across agents without feedback, foreign, or automaton rows by default", async () => {
    const seeded = await seedKnowledgeFixtures();
    const result = expectOk<ListThreadsResult>(
      await serviceFor(seeded.workspaceId).listThreads({ limit: 10 }),
    );

    expect(result.threads.map((thread) => thread.id)).toEqual([
      seeded.ids.activeB,
      seeded.ids.activeA,
      seeded.ids.archived,
      seeded.ids.old,
    ]);
    expect(result.threads.map((thread) => thread.status)).toEqual([
      "active",
      "active",
      "archived",
      "active",
    ]);
    expect(result.threads[1]).toMatchObject({
      id: seeded.ids.activeA,
      projectId: seeded.projectNeedle,
      projectName: "Needle Project",
      source: "manual",
      lastMessagePreview: "needle preview from active thread",
    });
  });

  it("applies source, status, project, and [since, until) filters", async () => {
    const seeded = await seedKnowledgeFixtures();
    const service = serviceFor(seeded.workspaceId);

    expect(
      expectOk<ListThreadsResult>(
        await service.listThreads({ includeAutomata: true, limit: 10 }),
      ).threads.map((thread) => thread.id),
    ).toEqual([
      seeded.ids.automaton,
      seeded.ids.activeB,
      seeded.ids.activeA,
      seeded.ids.archived,
      seeded.ids.old,
    ]);
    expect(
      expectOk<ListThreadsResult>(await service.listThreads({ status: "archived" })).threads.map(
        (thread) => thread.id,
      ),
    ).toEqual([seeded.ids.archived]);
    expect(
      expectOk<ListThreadsResult>(
        await service.listThreads({ status: "active", projectId: seeded.projectNeedle }),
      ).threads.map((thread) => thread.id),
    ).toEqual([seeded.ids.activeA]);
    expect(
      expectOk<ListThreadsResult>(
        await service.listThreads({
          since: new Date(baseTime + 20_000).toISOString(),
          until: new Date(baseTime + 30_001).toISOString(),
          limit: 10,
        }),
      ).threads.map((thread) => thread.id),
    ).toEqual([seeded.ids.activeB, seeded.ids.activeA, seeded.ids.archived]);
  });

  it("uses stable keyset pagination and rejects cursors reused with different filters", async () => {
    const seeded = await seedKnowledgeFixtures();
    const service = serviceFor(seeded.workspaceId);
    const first = expectOk<ListThreadsResult>(await service.listThreads({ limit: 2 }));

    expect(first.threads.map((thread) => thread.id)).toEqual([
      seeded.ids.activeB,
      seeded.ids.activeA,
    ]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const listCursor = first.nextCursor;
    if (listCursor === undefined) throw new Error("missing list cursor");

    const second = expectOk<ListThreadsResult>(
      await service.listThreads({ limit: 2, cursor: listCursor }),
    );
    expect(second.threads.map((thread) => thread.id)).toEqual([
      seeded.ids.archived,
      seeded.ids.old,
    ]);

    expect(
      expectError(await service.listThreads({ status: "active", cursor: listCursor })).code,
    ).toBe("invalid_cursor");
  });

  /**
   * A live turn invented `cursor: ":0"` on a FIRST call, retried with ":1" and
   * ":cursor:0", then sent `query: "*"`. Every rejection said only "Invalid
   * thread knowledge input.", so each retry was as blind as the last and the
   * model eventually gave up. An error a model cannot act on costs the task,
   * so the recovery has to be IN the message.
   */
  it("tells the model how to recover from a fabricated cursor", async () => {
    const service = serviceFor("workspace-cursor-guidance");
    const error = expectError(await service.listThreads({ cursor: ":0" }));

    expect(error.code).toBe("invalid_cursor");
    expect(error.message).toMatch(/omit `cursor`/i);
  });

  it("names the offending argument on a bad date bound", async () => {
    const service = serviceFor("workspace-date-guidance");

    expect(expectError(await service.listThreads({ since: "last week" })).message).toMatch(
      /`since` must be an absolute ISO-8601/i,
    );
    expect(
      expectError(
        await service.listThreads({ since: "2026-07-31T00:00:00Z", until: "2026-07-01T00:00:00Z" }),
      ).message,
    ).toMatch(/`since` must be earlier than `until`/i);
  });
});

describe("ThreadKnowledgeService search_threads/read_thread/grep_thread", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await resetRegistryState(env.REGISTRY_DB);
  });

  it("merges metadata and FTS hits, reports freshness, and paginates with offset cursors", async () => {
    const seeded = await seedKnowledgeFixtures();
    const service = serviceFor(seeded.workspaceId);

    const result = expectOk<SearchThreadsResult>(
      await service.searchThreads({
        query: "needle",
        status: "active",
      }),
    );

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      thread: { id: seeded.ids.activeA },
      matchedIn: ["title", "project", "preview", "message"],
      indexedThrough: baseTime + 30_000,
      indexState: "current",
    });
    expect(result.results[0]?.excerpts).toEqual([
      {
        messageId: "msg-active-needle",
        role: "assistant",
        createdAt: baseTime + 10_000,
        text: "The launch needle appears in the transcript.",
      },
    ]);
    expect(result.indexStatus).toEqual({
      pendingThreadCount: 1,
      oldestPendingUpdatedAt: baseTime + 30_000,
    });

    expect(
      expectOk<SearchThreadsResult>(
        await service.searchThreads({
          query: "needle!!!",
          status: "active",
        }),
      ).results.map((item) => item.thread.id),
    ).toEqual([seeded.ids.activeA]);

    const first = expectOk<SearchThreadsResult>(
      await service.searchThreads({ query: "needle", limit: 1 }),
    );
    expect(first.results.map((item) => item.thread.id)).toEqual([seeded.ids.activeA]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const searchCursor = first.nextCursor;
    if (searchCursor === undefined) throw new Error("missing search cursor");

    const second = expectOk<SearchThreadsResult>(
      await service.searchThreads({ query: "needle", limit: 1, cursor: searchCursor }),
    );
    expect(second.results.map((item) => item.thread.id)).toEqual([seeded.ids.archived]);
    expect(
      expectError(await service.searchThreads({ query: "changed", cursor: searchCursor })).code,
    ).toBe("invalid_cursor");
    expect(
      expectError(await service.searchThreads({ query: "needle!!!", cursor: searchCursor })).code,
    ).toBe("invalid_cursor");
  });

  it("explains that a wildcard query matches nothing", async () => {
    const service = serviceFor("workspace-query-guidance");
    const error = expectError(await service.searchThreads({ query: "*" }));

    expect(error.code).toBe("invalid_input");
    expect(error.message).toMatch(/wildcard|glob/i);
    expect(error.message).toMatch(/list_threads/);
  });

  it("returns multiple message-matching threads when one thread has many matching messages", async () => {
    const workspaceId = "workspace-fts-crowding";
    await insertWorkspace({ workspaceId, agentIds: ["agent-fts"] });
    await insertThread({
      id: "thread_fts_many",
      workspaceId,
      agentId: "agent-fts",
      title: "Busy transcript",
      preview: "ordinary preview",
      updatedAt: baseTime + 20_000,
      searchIndexedThrough: baseTime + 20_000,
    });
    await insertThread({
      id: "thread_fts_other",
      workspaceId,
      agentId: "agent-fts",
      title: "Other transcript",
      preview: "ordinary preview",
      updatedAt: baseTime + 10_000,
      searchIndexedThrough: baseTime + 10_000,
    });
    for (let index = 0; index < 4; index += 1) {
      await insertSearchMessage({
        workspaceId,
        threadId: "thread_fts_many",
        messageId: `msg-many-${index}`,
        createdAt: baseTime + index,
        content: "crowdtoken appears in this busy thread.",
      });
    }
    await insertSearchMessage({
      workspaceId,
      threadId: "thread_fts_other",
      messageId: "msg-other",
      createdAt: baseTime + 100,
      content: "crowdtoken appears in this other thread.",
    });

    const result = expectOk<SearchThreadsResult>(
      await serviceFor(workspaceId).searchThreads({ query: "crowdtoken", limit: 2 }),
    );

    expect(result.results.map((item) => item.thread.id)).toEqual([
      "thread_fts_many",
      "thread_fts_other",
    ]);
    expect(result.results[0]?.excerpts).toHaveLength(3);
  });

  it("prioritizes older title matches over newer preview matches in a tight search page", async () => {
    const workspaceId = "workspace-metadata-priority";
    await insertWorkspace({ workspaceId, agentIds: ["agent-metadata"] });
    await insertThread({
      id: "thread_preview_newest",
      workspaceId,
      agentId: "agent-metadata",
      title: "Newest preview-only thread",
      preview: "prioritytoken appears only in the newest preview",
      updatedAt: baseTime + 30_000,
      searchIndexedThrough: baseTime + 30_000,
    });
    await insertThread({
      id: "thread_preview_middle",
      workspaceId,
      agentId: "agent-metadata",
      title: "Middle preview-only thread",
      preview: "prioritytoken appears only in the middle preview",
      updatedAt: baseTime + 20_000,
      searchIndexedThrough: baseTime + 20_000,
    });
    await insertThread({
      id: "thread_title_oldest",
      workspaceId,
      agentId: "agent-metadata",
      title: "prioritytoken title match",
      preview: "ordinary preview",
      updatedAt: baseTime + 10_000,
      searchIndexedThrough: baseTime + 10_000,
    });

    const first = expectOk<SearchThreadsResult>(
      await serviceFor(workspaceId).searchThreads({ query: "prioritytoken", limit: 1 }),
    );

    expect(first.results.map((item) => item.thread.id)).toEqual(["thread_title_oldest"]);
    expect(first.results[0]?.matchedIn).toEqual(["title"]);
  });

  it("enriches FTS-only rows with metadata matches before ranking", async () => {
    const workspaceId = "workspace-fts-metadata-enrichment";
    await insertWorkspace({ workspaceId, agentIds: ["agent-rank"] });
    await insertProject({ id: "project_ranktoken", workspaceId, name: "ranktoken Project" });
    await insertThread({
      id: "thread_title_newest",
      workspaceId,
      agentId: "agent-rank",
      projectId: "project_ranktoken",
      title: "ranktoken newest title-only",
      preview: "ranktoken preview also matches",
      updatedAt: baseTime + 30_000,
      searchIndexedThrough: baseTime + 30_000,
    });
    await insertThread({
      id: "thread_title_middle",
      workspaceId,
      agentId: "agent-rank",
      projectId: "project_ranktoken",
      title: "ranktoken middle title-only",
      preview: "ranktoken preview also matches",
      updatedAt: baseTime + 20_000,
      searchIndexedThrough: baseTime + 20_000,
    });
    await insertThread({
      id: "thread_fts_title_project_preview",
      workspaceId,
      agentId: "agent-rank",
      projectId: "project_ranktoken",
      title: "ranktoken older transcript hit",
      preview: "ranktoken preview also matches",
      updatedAt: baseTime + 10_000,
      searchIndexedThrough: baseTime + 10_000,
    });
    await insertSearchMessage({
      workspaceId,
      threadId: "thread_fts_title_project_preview",
      messageId: "msg-ranktoken",
      createdAt: baseTime + 1,
      content: "ranktoken appears in the transcript, too.",
    });

    const first = expectOk<SearchThreadsResult>(
      await serviceFor(workspaceId).searchThreads({ query: "ranktoken", limit: 1 }),
    );

    expect(first.results.map((item) => item.thread.id)).toEqual([
      "thread_fts_title_project_preview",
    ]);
    expect(first.results[0]?.matchedIn).toEqual(["title", "project", "preview", "message"]);
  });

  it("hides automaton thread IDs unless automata are explicitly included", async () => {
    const seeded = await seedKnowledgeFixtures();
    const service = serviceFor(seeded.workspaceId);
    activeTranscriptRpcMock.mockResolvedValue({
      readThreadProsePage: vi.fn().mockResolvedValue({
        messages: [],
        omittedPartCount: 0,
        limited: false,
      }),
      grepThreadProse: vi.fn(),
    } satisfies Partial<ActiveTranscriptRpc>);

    expect(expectError(await service.readThread({ threadId: seeded.ids.automaton })).code).toBe(
      "not_found",
    );
    const included = expectOk<ReadThreadResult>(
      await service.readThread({ threadId: seeded.ids.automaton, includeAutomata: true }),
    );
    expect(included.thread.id).toBe(seeded.ids.automaton);
  });

  it("returns identical not_found errors for missing and foreign thread IDs", async () => {
    const seeded = await seedKnowledgeFixtures();
    const service = serviceFor(seeded.workspaceId);

    expect(expectError(await service.readThread({ threadId: "missing-thread" }))).toEqual(
      expectError(await service.readThread({ threadId: seeded.ids.foreign })),
    );
  });

  it("dispatches active reads and greps through the active transcript RPC", async () => {
    const seeded = await seedKnowledgeFixtures();
    const readThreadProsePage = vi.fn().mockResolvedValue({
      messages: [{ id: "active-user", role: "user", text: "active source text", createdAt: 1 }],
      omittedPartCount: 0,
      limited: false,
    });
    const grepThreadProse = vi.fn().mockResolvedValue({
      matches: [
        {
          messageId: "active-user",
          role: "user",
          createdAt: 1,
          line: 1,
          text: "active source text",
          before: [],
          after: [],
        },
      ],
      omittedPartCount: 0,
      limited: false,
    });
    activeTranscriptRpcMock.mockResolvedValue({
      readThreadProsePage,
      grepThreadProse,
    } satisfies Partial<ActiveTranscriptRpc>);

    const service = serviceFor(seeded.workspaceId);
    const read = expectOk<ReadThreadResult>(
      await service.readThread({ threadId: seeded.ids.activeA, limit: 1 }),
    );
    expect(read.thread.id).toBe(seeded.ids.activeA);
    expect(read.messages.map((item) => item.id)).toEqual(["active-user"]);
    expect(readThreadProsePage).toHaveBeenCalledWith({
      threadId: seeded.ids.activeA,
      includeAutomata: false,
      order: "chronological",
      limit: 1,
    });
    expect(activeTranscriptRpcMock).toHaveBeenCalledWith(env, { id: seeded.ids.activeA });

    const grep = expectOk<GrepThreadResult>(
      await service.grepThread({ threadId: seeded.ids.activeA, pattern: "source" }),
    );
    expect(grep.matches.map((match) => match.messageId)).toEqual(["active-user"]);
    expect(grepThreadProse).toHaveBeenCalledWith({
      threadId: seeded.ids.activeA,
      pattern: "source",
      includeAutomata: false,
    });
  });

  it("dispatches archived reads and greps through the archived adapter", async () => {
    const seeded = await seedKnowledgeFixtures();
    const service = serviceFor(seeded.workspaceId);

    const read = expectOk<ReadThreadResult>(
      await service.readThread({ threadId: seeded.ids.archived }),
    );
    expect(read.thread.id).toBe(seeded.ids.archived);
    expect(read.messages.map((item) => item.id)).toEqual(["archived-user", "archived-assistant"]);
    expect(activeTranscriptRpcMock).not.toHaveBeenCalled();

    const grep = expectOk<GrepThreadResult>(
      await service.grepThread({ threadId: seeded.ids.archived, pattern: "needle" }),
    );
    expect(grep.matches).toEqual([
      expect.objectContaining({
        messageId: "archived-user",
        role: "user",
        text: "archived source needle line",
      }),
    ]);
    expect(activeTranscriptRpcMock).not.toHaveBeenCalled();
  });

  it("maps FTS and source failures to structured errors", async () => {
    const seeded = await seedKnowledgeFixtures();
    const failingBinding = {
      prepare(sql: string) {
        if (sql.includes("thread_search_fts")) throw new Error("fts offline");
        return env.REGISTRY_DB.prepare(sql);
      },
    } as D1Database;
    expect(
      expectError(
        await serviceFor(seeded.workspaceId, failingBinding).searchThreads({ query: "needle" }),
      ).code,
    ).toBe("search_unavailable");

    activeTranscriptRpcMock.mockResolvedValue({
      readThreadProsePage: vi.fn().mockRejectedValue(new Error("do unavailable")),
      grepThreadProse: vi.fn(),
    } satisfies Partial<ActiveTranscriptRpc>);
    expect(
      expectError(await serviceFor(seeded.workspaceId).readThread({ threadId: seeded.ids.activeA }))
        .code,
    ).toBe("source_unavailable");
  });
});
