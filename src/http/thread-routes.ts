import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import { getAgentByName } from "agents";
import type { Env } from "../env";
import { validateRequestSession, type ValidatedSession } from "../auth/session";
import { registryBinding, registryDb } from "../db/client";
import { parseReasoningEffort, type ReasoningEffort } from "../agent/reasoning-options";
import {
  agents,
  automata,
  workbenches,
  projects,
  threadIndex,
  agentRepositories,
  workspaceMembers,
} from "../db/schema";
import { MAX_TITLE_LEN, ThreadRepository } from "../db/repositories/threads";
import { WorkspaceRepository } from "../db/repositories/workspaces";
import { serializeThread, type ThreadSummary } from "./thread-serialize";
import { decodeThreadCursor, encodeThreadCursor, fingerprintThreadQuery } from "./thread-cursor";
import { notifyWorkspaceMembers } from "../agent/notify-user";
import { normalizeThreadRuntime } from "../agent/thread-runtime";
import { archiveThreadCore } from "../agent/archive-thread";
import { createThreadWithWorkbench } from "../agent/create-thread";
import { WorkbenchRepository } from "../db/repositories/workbenches";
import { ArchivedMessageRepository } from "../db/repositories/archived-messages";
import { ArchivedCompactionRepository } from "../db/repositories/archived-compactions";
import { ThreadSearchProjectionRepository } from "../db/repositories/thread-search-projection";
import { log } from "../log";
import { ProjectRepository } from "../db/repositories/projects";
import { serializeErrorChain } from "../error-details";
import {
  resolveThreadModelSnapshotValue,
  type ThreadModelSnapshotError,
  type ThreadModelSnapshotTarget,
  type ThreadModelSnapshotValue,
} from "../settings/thread-model-snapshot";

// Named so the throw site (selectThreadSummariesForUser) and the catch site
// (listThreads, ~170 lines apart) are coupled by a type, not a string literal
// compared against `error.message`.
class InvalidThreadCursorError extends Error {
  constructor() {
    super("Invalid thread cursor");
    this.name = "InvalidThreadCursorError";
  }
}

interface ThreadDeletionStub {
  hasActiveTurn(): boolean | Promise<boolean>;
  destroy(): void | Promise<void>;
}

interface ThreadCompactionStub {
  compactThread(): Promise<{ compacted: boolean; reason?: string; message: string }>;
  getCompactionStatus(): Promise<{ phase: "idle" | "compacting" }>;
}

type ThreadModelSnapshotInput = {
  provider?: unknown;
  model?: unknown;
  modelInputModalities?: unknown;
  reasoningEffort?: unknown;
  modelSupportsReasoning?: unknown;
  projectId?: unknown;
  workbenchId?: unknown;
};

export async function routeThreads(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const url = new URL(req.url);

  if (url.pathname === "/api/threads/ensure") {
    return new Response("Not found", { status: 404 });
  }

  if (url.pathname === "/api/threads") {
    if (req.method === "GET") return listThreads(req, env);
    if (req.method === "POST") return createThread(req, env, ctx);
    return new Response("Method not allowed", { status: 405 });
  }

  if (url.pathname === "/api/threads/reconcile") {
    if (req.method === "POST") return reconcileThreads(req, env);
    return new Response("Method not allowed", { status: 405 });
  }

  const archiveThreadId = parseThreadArchivePath(url.pathname);
  if (archiveThreadId !== null) {
    if (req.method === "POST") return archiveThread(req, env, archiveThreadId, ctx);
    return new Response("Method not allowed", { status: 405 });
  }

  const dismissOutcomeThreadId = parseThreadDismissOutcomePath(url.pathname);
  if (dismissOutcomeThreadId !== null) {
    if (req.method === "POST") return dismissThreadOutcome(req, env, dismissOutcomeThreadId, ctx);
    return new Response("Method not allowed", { status: 405 });
  }

  const dismissRecentThreadId = parseThreadDismissRecentPath(url.pathname);
  if (dismissRecentThreadId !== null) {
    if (req.method === "POST") {
      return setThreadRecentDismissed(req, env, dismissRecentThreadId, ctx, true);
    }
    if (req.method === "DELETE") {
      return setThreadRecentDismissed(req, env, dismissRecentThreadId, ctx, false);
    }
    return new Response("Method not allowed", { status: 405 });
  }

  const summariesThreadId = parseThreadSummariesPath(url.pathname);
  if (summariesThreadId !== null) {
    if (req.method === "GET") return getArchivedSummaries(req, env, summariesThreadId);
    return new Response("Method not allowed", { status: 405 });
  }

  const messagesThreadId = parseThreadMessagesPath(url.pathname);
  if (messagesThreadId !== null) {
    if (req.method === "GET") return getThreadMessages(req, env, messagesThreadId);
    if (req.method === "POST") return sendThreadMessage(req, env, messagesThreadId);
    return new Response("Method not allowed", { status: 405 });
  }

  const seenThreadId = parseThreadSeenPath(url.pathname);
  if (seenThreadId !== null) {
    if (req.method === "POST") return markThreadSeen(req, env, seenThreadId, ctx);
    return new Response("Method not allowed", { status: 405 });
  }

  const compactStatusThreadId = parseThreadCompactStatusPath(url.pathname);
  if (compactStatusThreadId !== null) {
    if (req.method === "GET") return getThreadCompactionStatus(req, env, compactStatusThreadId);
    return new Response("Method not allowed", { status: 405 });
  }

  const compactThreadId = parseThreadCompactPath(url.pathname);
  if (compactThreadId !== null) {
    if (req.method === "POST") return compactThread(req, env, compactThreadId);
    return new Response("Method not allowed", { status: 405 });
  }

  const threadId = parseThreadIdPath(url.pathname);
  if (threadId !== null) {
    if (req.method === "GET") return getThread(req, env, threadId);
    if (req.method === "PATCH") return renameThread(req, env, threadId, ctx);
    if (req.method === "DELETE") return deleteThread(req, env, threadId, ctx);
    return new Response("Method not allowed", { status: 405 });
  }

  if (url.pathname.startsWith("/api/threads/")) {
    return new Response("Not found", { status: 404 });
  }

  return null;
}

const MAX_RECONCILE_THREAD_IDS = 100;

async function reconcileThreads(req: Request, env: Env): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid threadIds", { status: 400 });
  }
  const threadIds =
    body && typeof body === "object" && "threadIds" in body
      ? (body as { threadIds?: unknown }).threadIds
      : null;
  if (
    !Array.isArray(threadIds) ||
    threadIds.length === 0 ||
    threadIds.length > MAX_RECONCILE_THREAD_IDS ||
    !threadIds.every((id) => typeof id === "string" && id.trim().length > 0) ||
    new Set(threadIds).size !== threadIds.length
  ) {
    return new Response("Invalid threadIds", { status: 400 });
  }

  const rows = await registryDb(env)
    .select({ threadId: threadIndex.id })
    .from(threadIndex)
    .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, threadIndex.workspaceId))
    .where(
      and(
        eq(workspaceMembers.userId, session.user.id),
        ne(threadIndex.kind, "feedback"),
        isNull(threadIndex.archivedAt),
        inArray(threadIndex.id, threadIds),
      ),
    )
    .all();

  const active = new Set(rows.map((row) => row.threadId));
  return Response.json({ activeThreadIds: threadIds.filter((id) => active.has(id)) });
}

async function compactThread(req: Request, env: Env, threadId: string): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const db = registryDb(env);
  const thread = await new ThreadRepository(db).getById(threadId);
  if (!thread) return new Response("Not found", { status: 404 });
  if (isFeedbackThread(thread)) return new Response("Not found", { status: 404 });

  try {
    await new WorkspaceRepository(db).assertMember({
      workspaceId: thread.workspaceId,
      userId: session.user.id,
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }

  if (thread.archivedAt != null) {
    return new Response("Archived threads are read-only", { status: 409 });
  }

  if (normalizeThreadRuntime(thread.runtime) !== "think") {
    return new Response("Thread compaction is only available for Think threads", { status: 400 });
  }

  // MUST be getAgentByName, not a raw idFromName stub: compactThread() reads
  // this.session, which onStart() (skipped by a raw DO RPC) assigns. A thread
  // whose DO was never warmed by a client throws "Cannot read properties of
  // undefined (reading 'compact')" on a raw stub.
  const stub = (await getAgentByName(
    env.THINK_THREAD_AGENT,
    threadId,
  )) as unknown as ThreadCompactionStub;
  let result: { compacted: boolean; reason?: string; message: string };
  try {
    result = await stub.compactThread();
  } catch (error) {
    if (error instanceof Error && error.message === "thread_compaction_not_stable") {
      return new Response("Thread is responding; try again once it finishes", { status: 409 });
    }
    log.warn("thread.compaction_failed", { threadId, error: String(error) });
    return new Response("Could not compact thread", { status: 500 });
  }
  return Response.json(result);
}

async function getThreadCompactionStatus(
  req: Request,
  env: Env,
  threadId: string,
): Promise<Response> {
  // The session lookup and the thread read are independent, and each D1
  // round-trip is ~220ms; only assertMember needs both. Two waves, not three.
  const db = registryDb(env);
  const [session, thread] = await Promise.all([
    validateRequestSession(env, req),
    new ThreadRepository(db).getById(threadId),
  ]);
  if (!session) return new Response("Unauthorized", { status: 401 });
  if (!thread) return new Response("Not found", { status: 404 });
  if (isFeedbackThread(thread)) return new Response("Not found", { status: 404 });

  try {
    await new WorkspaceRepository(db).assertMember({
      workspaceId: thread.workspaceId,
      userId: session.user.id,
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }

  if (normalizeThreadRuntime(thread.runtime) !== "think") {
    return new Response("Thread compaction is only available for Think threads", { status: 400 });
  }

  // Same getAgentByName requirement as compactThread() above: getCompactionStatus()
  // is a synchronous read of this.compactionPhase, but the RPC still round-trips
  // through the DO instance, which onStart() must have initialized first.
  const stub = (await getAgentByName(
    env.THINK_THREAD_AGENT,
    threadId,
  )) as unknown as ThreadCompactionStub;
  const status = await stub.getCompactionStatus();
  return Response.json(status);
}

export const DEFAULT_THREAD_PAGE = 30;
export const MAX_THREAD_PAGE = 100;

// A null sort value here means the query's own guarantees (updatedAt is
// NOT NULL; the archived branch filters isNotNull(archivedAt)) have been
// broken elsewhere. `?? 0` would silently truncate the list instead: SQLite
// NULL comparisons never match, so a cursor built from 0 would just end the
// walk with no error, hiding exactly the bug class this cursor exists to
// prevent. Throw instead.
function requireSortValue(value: number | null | undefined, key: string, id: string): number {
  if (value === null || value === undefined) {
    throw new Error(`Thread ${id} is missing its ${key} sort value; cannot build a cursor`);
  }
  return value;
}

/**
 * LIKE metacharacters in user input. Without this, "50%" matches everything and
 * "a_b" matches "axb" — the search looks broken rather than strict.
 */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * A user's threads across every workspace they belong to, newest-first.
 * Extracted so the startup bootstrap route can reuse the exact query the
 * `GET /api/threads` handler serves, without a second round trip.
 */
export async function selectThreadSummariesForUser(
  env: Env,
  userId: string,
  status: "active" | "archived" | "all" = "active",
  project: "all" | "unassigned" | { projectId: string } = "all",
  options: { limit?: number; cursor?: string; q?: string } = {},
): Promise<{ threads: ThreadSummary[]; nextCursor: string | null }> {
  const db = registryDb(env);
  // Archived lists read newest-archived-first; everything else newest-touched.
  // Decided ONCE and reused for both the ORDER BY column and the cursor's
  // sortValue below: two independent ternaries here previously risked
  // disagreeing, which would either repeat page 1 forever or silently drop
  // the tail of the archived list.
  const sortKey = status === "archived" ? "archivedAt" : "updatedAt";
  const sortColumn = threadIndex[sortKey];

  const cursor = options.cursor === undefined ? null : decodeThreadCursor(options.cursor);
  if (options.cursor !== undefined && cursor === null) {
    // Louder than resetting to page one: a cursor we can't read means the
    // caller's paging is already wrong, and silently restarting hides it.
    throw new InvalidThreadCursorError();
  }
  const fingerprint = fingerprintThreadQuery({ sortKey, q: options.q, project });
  if (cursor && cursor.fingerprint !== fingerprint) {
    // A cursor is a position in a specific query (this status, this `q`, this
    // project filter) — not a position in general. Answering a mismatched
    // cursor with a plausible-looking slice (e.g. comparing an archivedAt
    // cursor against updatedAt rows) is exactly the silent-wrongness this
    // cursor exists to prevent elsewhere; reject it the same way as junk.
    throw new InvalidThreadCursorError();
  }
  // A cursor is a position in the sort, so it needs the tie-break too: rows
  // sharing a sortValue are ordered by id, and page 2 resumes inside that run.
  const cursorFilters = cursor
    ? [
        or(
          lt(sortColumn, cursor.sortValue),
          and(eq(sortColumn, cursor.sortValue), lt(threadIndex.id, cursor.id)),
        ),
      ]
    : [];

  // Number.isFinite guards against NaN reaching query.limit(): a route parser
  // should already reject a non-numeric limit, but this needs to be total on
  // its own rather than trusting every future caller to have validated
  // first. Same rationale as the cursor-decode throw above: silently
  // clamping a non-finite limit to MAX_THREAD_PAGE would hand a broken
  // caller a valid-looking page plus a valid-looking nextCursor, hiding
  // exactly the bug class this cursor exists to prevent. Throw instead.
  if (options.limit !== undefined && !Number.isFinite(options.limit)) {
    throw new Error("Invalid thread limit");
  }
  // Clamping (not throwing) an oversized limit is deliberate, unlike the
  // throws above and below: a clamped request still returns a COMPLETE,
  // resumable result set — up to MAX_THREAD_PAGE rows plus a correct
  // nextCursor the caller can page through to reach everything. That is
  // materially different from truncating a result set with no way back,
  // which is what the throw-instead-of-clamp convention in this function
  // exists to prevent.
  const limit =
    options.limit === undefined ? null : Math.max(1, Math.min(options.limit, MAX_THREAD_PAGE));

  const projectFilters =
    project === "all"
      ? []
      : project === "unassigned"
        ? [isNull(threadIndex.projectId)]
        : [eq(threadIndex.projectId, project.projectId)];
  const query = db
    .select({
      id: threadIndex.id,
      workspaceId: threadIndex.workspaceId,
      agentId: threadIndex.agentId,
      modelProvider: threadIndex.modelProvider,
      model: threadIndex.model,
      modelInputModalities: threadIndex.modelInputModalities,
      reasoningEffort: threadIndex.reasoningEffort,
      modelSupportsReasoning: threadIndex.modelSupportsReasoning,
      kind: threadIndex.kind,
      runtime: threadIndex.runtime,
      activityStatus: threadIndex.activityStatus,
      currentTurnStartedAt: threadIndex.currentTurnStartedAt,
      attentionRequiredAt: threadIndex.attentionRequiredAt,
      title: threadIndex.title,
      source: threadIndex.source,
      lastMessagePreview: threadIndex.lastMessagePreview,
      unreadOutcome: threadIndex.unreadOutcome,
      unreadOutcomeAt: threadIndex.unreadOutcomeAt,
      lastSeenAt: threadIndex.lastSeenAt,
      archivedAt: threadIndex.archivedAt,
      projectId: threadIndex.projectId,
      projectName: projects.name,
      workbenchId: threadIndex.workbenchId,
      workbenchName: workbenches.name,
      snapshotResourceProfile: workbenches.resourceProfile,
      automatonId: threadIndex.automatonId,
      automatonName: automata.name,
      outcomeDismissedAt: threadIndex.outcomeDismissedAt,
      recentDismissedAt: threadIndex.recentDismissedAt,
      automatonNotifyMode: automata.notifyMode,
      repositorySnapshotCount: sql<number>`count(${agentRepositories.id})`,
      lastContextTokens: threadIndex.lastContextTokens,
      lastContextWindow: threadIndex.lastContextWindow,
      lastCompactAfterTokens: threadIndex.lastCompactAfterTokens,
      createdAt: threadIndex.createdAt,
      updatedAt: threadIndex.updatedAt,
    })
    .from(threadIndex)
    .leftJoin(projects, eq(projects.id, threadIndex.projectId))
    .leftJoin(workbenches, eq(workbenches.id, threadIndex.workbenchId))
    .leftJoin(automata, eq(automata.id, threadIndex.automatonId))
    // The environment's LIVE repositories; this is the join that can multiply
    // rows, which is why the aggregate + groupBy below stay.
    .leftJoin(agentRepositories, eq(agentRepositories.agentId, threadIndex.workbenchId))
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, threadIndex.workspaceId),
        eq(workspaceMembers.userId, userId),
        ne(threadIndex.kind, "feedback"),
        ...projectFilters,
        ...(status === "active"
          ? [isNull(threadIndex.archivedAt)]
          : status === "archived"
            ? [isNotNull(threadIndex.archivedAt)]
            : []),
        or(
          isNull(threadIndex.automatonId),
          // A hard-deleted automaton leaves notify_mode NULL via the left join;
          // default such orphans to visible, matching the web predicate.
          isNull(automata.notifyMode),
          ne(automata.notifyMode, "failures_only"),
          and(
            isNull(threadIndex.outcomeDismissedAt),
            or(
              isNotNull(threadIndex.attentionRequiredAt),
              eq(threadIndex.activityStatus, "failed"),
            ),
          ),
        ),
      ),
    )
    .groupBy(
      threadIndex.id,
      projects.name,
      workbenches.name,
      workbenches.resourceProfile,
      automata.name,
    )
    // The tie-break must be in the ORDER BY too, or the cursor's idea of "next"
    // disagrees with the order rows actually come back in.
    .orderBy(desc(sortColumn), desc(threadIndex.id));

  // Cursor and search go in a WHERE, not the innerJoin's ON clause where the
  // existing filters live: `q` matches on `projects.name`, which is LEFT joined
  // after threadIndex, and constraining a left-joined table from an earlier
  // join's ON clause is a different query than it looks.
  const whereFilters = [...cursorFilters];
  const q = options.q?.trim();
  if (q) {
    const pattern = likePattern(q);
    // SQLite's LIKE folds ASCII A-Z only; the client's toLowerCase() is Unicode-aware.
    // Non-ASCII case variants ("École" vs "école") therefore diverge — accepted: D1 has
    // no ICU extension and lower() is ASCII-only too, so the honest alternatives are a
    // stored normalised column or nothing. No index can serve a leading-wildcard LIKE —
    // also accepted, it is scoped to this user's workspaces.
    whereFilters.push(
      or(
        sql`${threadIndex.title} LIKE ${pattern} ESCAPE '\\'`,
        sql`${threadIndex.lastMessagePreview} LIKE ${pattern} ESCAPE '\\'`,
        sql`${projects.name} LIKE ${pattern} ESCAPE '\\'`,
      )!,
    );
  }
  if (whereFilters.length > 0) query.where(and(...whereFilters));

  // One extra row is the cheapest possible "is there more?" — no COUNT.
  const rows = await (limit === null ? query.all() : query.limit(limit + 1).all());

  if (limit === null) return { threads: rows.map(serializeThread), nextCursor: null };

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > limit && last
      ? encodeThreadCursor({
          sortValue: requireSortValue(last[sortKey], sortKey, last.id),
          id: last.id,
          fingerprint,
        })
      : null;
  return { threads: page.map(serializeThread), nextCursor };
}

async function listThreads(req: Request, env: Env): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const url = new URL(req.url);
  const status = parseThreadListStatus(url.searchParams.get("status"));
  if (!status.ok) return status.response;
  const project = parseThreadProjectFilter(url.searchParams);
  if (!project.ok) return project.response;
  const limit = parseThreadLimit(url.searchParams.get("limit"));
  if (!limit.ok) return limit.response;

  const cursor = url.searchParams.get("cursor") || undefined;
  const q = url.searchParams.get("q") ?? undefined;

  try {
    const page = await selectThreadSummariesForUser(
      env,
      session.user.id,
      status.value,
      project.value,
      {
        ...(limit.value === undefined ? {} : { limit: limit.value }),
        ...(cursor === undefined ? {} : { cursor }),
        ...(q === undefined ? {} : { q }),
      },
    );
    return Response.json({ threads: page.threads, nextCursor: page.nextCursor });
  } catch (error) {
    if (error instanceof InvalidThreadCursorError) {
      return new Response("Invalid thread cursor", { status: 400 });
    }
    throw error;
  }
}

async function getThread(req: Request, env: Env, threadId: string): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const db = registryDb(env);
  const thread = await new ThreadRepository(db).getById(threadId);
  if (!thread) return new Response("Not found", { status: 404 });
  if (isFeedbackThread(thread)) return new Response("Not found", { status: 404 });

  try {
    await new WorkspaceRepository(db).assertMember({
      workspaceId: thread.workspaceId,
      userId: session.user.id,
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }

  const summary = await selectThreadSummaryForMember(env, session.user.id, threadId);
  if (!summary) return new Response("Not found", { status: 404 });
  return Response.json({ thread: summary });
}

interface ThreadHistoryStub {
  exportHistory(): Promise<unknown[]>;
}

/**
 * The compaction summaries of an archived thread.
 *
 * `/messages` now returns the RAW transcript — archiving must not destroy the
 * messages a summary hid, so the archive holds everything. The summaries are kept
 * alongside so a long archived thread can still be read as its digest; they are
 * served separately because a summary is a VIEW, and mixing it into the message
 * list is exactly what corrupted live threads.
 */
async function getArchivedSummaries(req: Request, env: Env, threadId: string): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const db = registryDb(env);
  const thread = await new ThreadRepository(db).getById(threadId);
  if (!thread) return new Response("Not found", { status: 404 });
  if (isFeedbackThread(thread)) return new Response("Not found", { status: 404 });

  try {
    await new WorkspaceRepository(db).assertMember({
      workspaceId: thread.workspaceId,
      userId: session.user.id,
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }

  return Response.json(await new ArchivedCompactionRepository(db).listForThread(threadId));
}

async function getThreadMessages(req: Request, env: Env, threadId: string): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const db = registryDb(env);
  const thread = await new ThreadRepository(db).getById(threadId);
  if (!thread) return new Response("Not found", { status: 404 });
  if (isFeedbackThread(thread)) return new Response("Not found", { status: 404 });

  try {
    await new WorkspaceRepository(db).assertMember({
      workspaceId: thread.workspaceId,
      userId: session.user.id,
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }

  // `archivedAt` alone is the switch. An archived thread had its DO evicted at
  // archive time, so its history lives entirely in the D1 snapshot — read it and
  // never touch a DO. No backfill: a thread archived before this feature has an
  // empty snapshot and simply reads empty; we do not fall back to its old DO.
  if (thread.archivedAt != null) {
    return Response.json(await new ArchivedMessageRepository(db).listForThread(threadId));
  }

  // An unarchived row on the retired runtime has no DO to read: its class is
  // gone, and dialing Think would mint an empty phantom under a name that never
  // belonged to it. Serve empty rather than fabricate a thread.
  if (normalizeThreadRuntime(thread.runtime) !== "think") {
    return Response.json([]);
  }

  // Active thread: read the live DO. MUST be getAgentByName, not a raw
  // idFromName stub: Think hydrates its transcript in onStart(), which a native
  // DO RPC skips — a cold (idle, evicted) DO would report an empty history.
  const stub = (await getAgentByName(
    env.THINK_THREAD_AGENT,
    threadId,
  )) as unknown as ThreadHistoryStub;
  return Response.json(await stub.exportHistory());
}

interface ThreadSubmitStub {
  submitQueuedUserMessage(input: unknown): Promise<unknown>;
}

/**
 * Deliver a user message into a live thread from the Worker. This is the path
 * the new-thread composer uses for its first message: it must not depend on a
 * mounted client, so that navigating away mid-send still delivers the message
 * to the thread it was written for.
 *
 * Reuses the agent's existing queued-submission path. On an idle thread there
 * is no waiting batch, so the submission simply becomes the next turn — the
 * SDK drain loop runs it with no client attached (same as an automaton run).
 */
async function sendThreadMessage(req: Request, env: Env, threadId: string): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const body = await parseOptionalJsonBody(req);
  if (!body.ok) return body.response;
  if (body.body === null || typeof body.body !== "object" || Array.isArray(body.body)) {
    return new Response("Invalid JSON", { status: 400 });
  }

  const db = registryDb(env);
  const thread = await new ThreadRepository(db).getById(threadId);
  if (!thread) return new Response("Not found", { status: 404 });
  if (isFeedbackThread(thread)) return new Response("Not found", { status: 404 });

  try {
    await new WorkspaceRepository(db).assertMember({
      workspaceId: thread.workspaceId,
      userId: session.user.id,
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }

  if (thread.archivedAt != null) {
    return new Response("Archived threads are read-only", { status: 409 });
  }
  if (normalizeThreadRuntime(thread.runtime) !== "think") {
    return new Response("This thread cannot receive messages", { status: 400 });
  }

  // MUST be getAgentByName, not a raw idFromName stub: a brand-new thread has
  // never had a client, so a native DO RPC would skip onStart() and leave the
  // agent uninitialized. See src/automata/fire-due.ts for the full note.
  const stub = (await getAgentByName(
    env.THINK_THREAD_AGENT,
    threadId,
  )) as unknown as ThreadSubmitStub;

  try {
    await stub.submitQueuedUserMessage({ message: (body.body as { message?: unknown }).message });
  } catch (error) {
    // normalizeQueuedUserMessageInput throws these for a malformed/empty message.
    const message = String(error);
    if (message.includes("queued_message_")) {
      return new Response("Message is empty or malformed", { status: 400 });
    }
    log.warn("thread.send_message_failed", {
      threadId,
      error: message,
      errorChain: serializeErrorChain(error),
    });
    return new Response("Could not send the message", { status: 500 });
  }

  return Response.json({ ok: true }, { status: 202 });
}

/**
 * Clear the thread's unread marker. This is also what "acknowledge a failed
 * automata run" means — deliberately so. It must NOT demote `activityStatus`
 * from "failed" to "idle": nothing renders that field on its own, and its one
 * consumer is the failures-only visibility rule in listThreads, where a failed
 * automaton thread is visible BECAUSE it failed. Demoting it would delete the
 * thread from All chats. `attentionRequiredAt` is left alone for the opposite
 * reason: it means a live approval gate is still blocking the run.
 */
async function markThreadSeen(
  req: Request,
  env: Env,
  threadId: string,
  ctx: ExecutionContext,
): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const db = registryDb(env);
  const repo = new ThreadRepository(db);
  const thread = await repo.getById(threadId);
  if (!thread) return new Response("Not found", { status: 404 });
  if (isFeedbackThread(thread)) return new Response("Not found", { status: 404 });

  try {
    await new WorkspaceRepository(db).assertMember({
      workspaceId: thread.workspaceId,
      userId: session.user.id,
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }

  await db
    .update(threadIndex)
    .set({ unreadOutcome: null, unreadOutcomeAt: null, lastSeenAt: Date.now() })
    .where(eq(threadIndex.id, threadId));

  const updated = await repo.getSummaryRowById(threadId);
  if (!updated) return new Response("Not found", { status: 404 });
  const summary = serializeThread(updated);

  // Broadcast so clearing the marker on one device clears it on the others.
  // Without this the dot stayed lit everywhere else until the next refresh.
  ctx.waitUntil(
    notifyWorkspaceMembers(env, thread.workspaceId, {
      type: "thread.updated",
      thread: summary,
    }),
  );

  return Response.json({ thread: summary });
}

/**
 * Set or clear the thread's dismissal from the sidebar rail. POST dismisses,
 * DELETE restores (Undo, and the un-dismiss that happens when the thread is
 * opened again).
 *
 * `updatedAt` is deliberately NOT touched. The rail hides a thread only while
 * `recentDismissedAt >= updatedAt`, so bumping `updatedAt` here would satisfy
 * the dismissal's own expiry in the same statement that created it — the row
 * would come straight back and the feature would silently do nothing. That is
 * also what makes the dismissal self-expiring: real activity moves `updatedAt`
 * past the stamp on its own, with no un-dismiss job to run.
 */
async function setThreadRecentDismissed(
  req: Request,
  env: Env,
  threadId: string,
  ctx: ExecutionContext,
  dismissed: boolean,
): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const db = registryDb(env);
  const repo = new ThreadRepository(db);
  const thread = await repo.getById(threadId);
  if (!thread) return new Response("Not found", { status: 404 });
  if (isFeedbackThread(thread)) return new Response("Not found", { status: 404 });

  try {
    await new WorkspaceRepository(db).assertMember({
      workspaceId: thread.workspaceId,
      userId: session.user.id,
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }

  await db
    .update(threadIndex)
    .set({ recentDismissedAt: dismissed ? Date.now() : null })
    .where(eq(threadIndex.id, threadId));

  const updated = await repo.getSummaryRowById(threadId);
  if (!updated) return new Response("Not found", { status: 404 });
  const summary = serializeThread(updated);

  ctx.waitUntil(
    notifyWorkspaceMembers(env, thread.workspaceId, {
      type: "thread.updated",
      thread: summary,
    }),
  );

  return Response.json({ thread: summary });
}

async function archiveThread(
  req: Request,
  env: Env,
  threadId: string,
  ctx: ExecutionContext,
): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const db = registryDb(env);
  const repo = new ThreadRepository(db);
  const thread = await repo.getById(threadId);
  if (!thread) return new Response("Not found", { status: 404 });
  if (isFeedbackThread(thread)) return new Response("Not found", { status: 404 });

  try {
    await new WorkspaceRepository(db).assertMember({
      workspaceId: thread.workspaceId,
      userId: session.user.id,
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }

  // A stale active-list row can outlive the archive transition (for example
  // while another device is archiving it). Treat a repeat archive as an
  // idempotent read so we never re-enter the snapshot/DO-eviction path.
  if (thread.archivedAt != null) {
    const summary = await selectThreadSummaryForMember(env, session.user.id, threadId);
    if (!summary) return new Response("Not found", { status: 404 });
    return Response.json({ thread: summary });
  }

  const outcome = await archiveThreadCore(env, threadId);
  if (outcome === "active_turn") {
    return new Response("Thread is responding; try again once it finishes", { status: 409 });
  }
  if (outcome === "empty_snapshot") {
    // Automatic archiving keeps the empty-snapshot safeguard, but an explicit
    // user retry must be able to clear a stale empty row from active lists.
    // Mark it archived without destroying a possibly-unhydrated DO.
    await repo.archive(threadId, Date.now());
  }

  const archived = await repo.getById(threadId);
  if (!archived) return new Response("Not found", { status: 404 });
  const summary = await selectThreadSummaryForMember(env, session.user.id, threadId);
  if (!summary) return new Response("Not found", { status: 404 });

  ctx.waitUntil(
    notifyWorkspaceMembers(env, archived.workspaceId, {
      type: "thread.archived",
      thread: summary,
    }),
  );

  return Response.json({ thread: summary });
}

async function dismissThreadOutcome(
  req: Request,
  env: Env,
  threadId: string,
  ctx: ExecutionContext,
): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const db = registryDb(env);
  const repo = new ThreadRepository(db);
  const thread = await repo.getById(threadId);
  if (!thread) return new Response("Not found", { status: 404 });
  if (isFeedbackThread(thread)) return new Response("Not found", { status: 404 });

  try {
    await new WorkspaceRepository(db).assertMember({
      workspaceId: thread.workspaceId,
      userId: session.user.id,
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }

  const now = Date.now();
  await db
    .update(threadIndex)
    .set({ outcomeDismissedAt: now, updatedAt: now })
    .where(eq(threadIndex.id, threadId));

  const updated = await repo.getSummaryRowById(threadId);
  if (!updated) return new Response("Not found", { status: 404 });
  const summary = serializeThread(updated);

  ctx.waitUntil(
    notifyWorkspaceMembers(env, thread.workspaceId, {
      type: "thread.updated",
      thread: summary,
    }),
  );

  return Response.json({ thread: summary });
}

async function deleteThread(
  req: Request,
  env: Env,
  threadId: string,
  ctx: ExecutionContext,
): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const db = registryDb(env);
  const repo = new ThreadRepository(db);
  const thread = await repo.getById(threadId);
  if (!thread) return new Response("Not found", { status: 404 });
  if (isFeedbackThread(thread)) return new Response("Not found", { status: 404 });

  try {
    await new WorkspaceRepository(db).assertMember({
      workspaceId: thread.workspaceId,
      userId: session.user.id,
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }

  // Only a live (non-archived) thread has a Durable Object to guard and evict.
  // `archivedAt` is the switch: an archived thread had its DO destroyed at
  // archive time, so we never rehydrate it here — not to check for an active turn
  // (archiving already proved there was none) nor to destroy it again.
  // A row on the retired runtime is skipped for the same reason: its DO class no
  // longer exists, so there is nothing to guard or evict — only the D1 rows below.
  if (thread.archivedAt == null && normalizeThreadRuntime(thread.runtime) === "think") {
    const stub = env.THINK_THREAD_AGENT.get(
      env.THINK_THREAD_AGENT.idFromName(threadId),
    ) as ThreadDeletionStub;

    // Refuse to delete a thread whose turn is still streaming. destroy() would
    // abort the in-flight turn and orphan its partial reply, so guard on the DO —
    // the single global instance that actually knows whether a turn is active.
    if (await stub.hasActiveTurn()) {
      return new Response("Thread is responding; try again once it finishes", { status: 409 });
    }

    // Evict the Durable Object before deleting the index row: instantiating the DO
    // runs ThinkThreadAgent.onStart(), which throws if the thread_index row is gone.
    // destroy() deletes all DO storage then aborts the isolate, so the RPC rejects
    // even on success — swallow it and treat as fire-and-forget.
    try {
      await stub.destroy();
    } catch {
      // Expected: destroy() aborts the isolate after deleting storage.
    }
  }

  await new ArchivedMessageRepository(db).deleteForThread(threadId);
  // The summaries are archived alongside the raw transcript — delete them with it,
  // or a deleted thread leaves its digest behind in D1.
  await new ArchivedCompactionRepository(db).deleteForThread(threadId);
  await new ThreadSearchProjectionRepository(registryBinding(env)).deleteForThread(threadId);
  await repo.delete(threadId);

  ctx.waitUntil(
    notifyWorkspaceMembers(env, thread.workspaceId, {
      type: "thread.deleted",
      threadId,
      workspaceId: thread.workspaceId,
    }),
  );

  return new Response(null, { status: 204 });
}

async function createThread(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const db = registryDb(env);
  const target = await selectThreadTarget(env, session);
  if (!target) return new Response("Workspace agent not found", { status: 404 });

  const body = await parseOptionalJsonBody(req);
  if (!body.ok) return body.response;

  const snapshot = await resolveThreadModelSnapshot(
    env,
    target,
    body.body === null ? {} : body.body,
    session.user.email,
  );
  if (!snapshot.ok) return snapshot.response;
  const projectId = await resolveThreadProjectId(
    db,
    target.workspaceId,
    (body.body ?? {}) as ThreadModelSnapshotInput,
  );
  if (!projectId.ok) return projectId.response;
  const workbenchId = await resolveThreadWorkbenchId(
    db,
    target.workspaceId,
    projectId.value,
    (body.body ?? {}) as ThreadModelSnapshotInput,
  );
  if (!workbenchId.ok) return workbenchId.response;

  const createdAt = Date.now();
  const thread = {
    id: `thr_${crypto.randomUUID()}`,
    workspaceId: target.workspaceId,
    agentId: target.agentId,
    projectId: projectId.value,
    modelProvider: snapshot.value.provider,
    model: snapshot.value.model,
    modelInputModalities: JSON.stringify(snapshot.value.modelInputModalities),
    reasoningEffort: snapshot.value.reasoningEffort,
    modelSupportsReasoning: snapshot.value.modelSupportsReasoning,
    title: "New thread",
    titleSet: false,
    runtime: "think" as const,
    source: "manual" as const,
    automatonId: null,
    automatonRunId: null,
    lastEventId: null,
    lastMessagePreview: "",
    createdAt,
    updatedAt: createdAt,
  };
  await createThreadWithWorkbench(db, thread, workbenchId.value);

  const summary = await selectThreadSummaryForMember(env, session.user.id, thread.id);
  if (!summary) return new Response("Not found", { status: 404 });

  ctx.waitUntil(
    notifyWorkspaceMembers(env, thread.workspaceId, {
      type: "thread.created",
      thread: summary,
    }),
  );

  return Response.json({ thread: summary }, { status: 201 });
}

async function renameThread(
  req: Request,
  env: Env,
  threadId: string,
  ctx: ExecutionContext,
): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const body = await req.json().catch(() => invalidJsonBody);
  if (body === invalidJsonBody) return new Response("Invalid JSON", { status: 400 });
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return new Response("Invalid JSON", { status: 400 });
  }

  const db = registryDb(env);
  const repo = new ThreadRepository(db);
  const thread = await repo.getById(threadId);
  if (!thread) return new Response("Not found", { status: 404 });
  if (isFeedbackThread(thread)) return new Response("Not found", { status: 404 });
  try {
    await new WorkspaceRepository(db).assertMember({
      workspaceId: thread.workspaceId,
      userId: session.user.id,
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }

  if (thread.archivedAt != null) {
    return new Response("Archived threads are read-only", { status: 409 });
  }

  const patch = body as {
    title?: unknown;
    projectId?: unknown;
    workbenchId?: unknown;
    reasoningEffort?: unknown;
  };
  const title = parseThreadTitlePatch(patch.title);
  if (!title.ok) return title.response;
  const projectId = await resolveThreadProjectPatch(db, thread.workspaceId, patch.projectId);
  if (!projectId.ok) return projectId.response;
  const workbenchId = await resolveThreadWorkbenchPatch(db, thread.workspaceId, patch.workbenchId);
  if (!workbenchId.ok) return workbenchId.response;
  const reasoningEffort = parseThreadReasoningEffortPatch(patch.reasoningEffort);
  if (!reasoningEffort.ok) return reasoningEffort.response;
  if (
    !title.hasValue &&
    !projectId.hasValue &&
    !workbenchId.hasValue &&
    !reasoningEffort.hasValue
  ) {
    return new Response("No valid fields to update", { status: 400 });
  }

  const updatedAt = Date.now();
  if (title.hasValue) {
    await repo.update(threadId, { title: title.value, titleSet: true, updatedAt });
  }
  if (reasoningEffort.hasValue) {
    await repo.update(threadId, { reasoningEffort: reasoningEffort.value, updatedAt });
  }
  if (projectId.hasValue) {
    await repo.updateProject(threadId, projectId.value, updatedAt);
  }
  if (workbenchId.hasValue) {
    // A plain column write, live compute or not: configuration is LIVE, so the
    // next turn's preparation reads the new environment. There is no snapshot
    // to move and therefore no save-your-work handshake to run first.
    await repo.updateWorkbench(threadId, workbenchId.value, updatedAt);
  }

  const updated = await selectThreadSummaryForMember(env, session.user.id, threadId);
  if (!updated) return new Response("Not found", { status: 404 });

  ctx.waitUntil(
    notifyWorkspaceMembers(env, updated.workspaceId, {
      type: "thread.updated",
      thread: updated,
    }),
  );

  return Response.json({ thread: updated });
}

async function selectThreadTarget(env: Env, session: ValidatedSession) {
  const db = registryDb(env);
  return db
    .select({
      workspaceId: workspaceMembers.workspaceId,
      agentId: agents.id,
      provider: agents.provider,
      model: agents.model,
      modelInputModalities: agents.modelInputModalities,
      reasoningEffort: agents.reasoningEffort,
      modelSupportsReasoning: agents.modelSupportsReasoning,
    })
    .from(workspaceMembers)
    .innerJoin(agents, eq(agents.workspaceId, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, session.user.id))
    .orderBy(asc(workspaceMembers.createdAt), asc(agents.createdAt))
    .get();
}

const THREAD_MODEL_SNAPSHOT_MESSAGES: Record<ThreadModelSnapshotError, string> = {
  malformed_body: "Thread snapshot must be an object",
  unsupported_provider: "unsupported provider",
  provider_not_usable: "provider is not usable",
  invalid_model: "model must be a non-empty string",
  invalid_modalities: "modelInputModalities must be an array of supported modalities",
  invalid_reasoning_effort: "reasoningEffort must be one of off, low, medium, high",
  invalid_model_supports_reasoning: "modelSupportsReasoning must be a boolean or null",
};

async function resolveThreadModelSnapshot(
  env: Env,
  target: ThreadModelSnapshotTarget,
  body: unknown,
  viewerEmail: string | null | undefined,
): Promise<{ ok: true; value: ThreadModelSnapshotValue } | { ok: false; response: Response }> {
  const result = await resolveThreadModelSnapshotValue(env, target, body, viewerEmail);
  if (result.ok) return result;
  return {
    ok: false,
    response: new Response(THREAD_MODEL_SNAPSHOT_MESSAGES[result.error], { status: 400 }),
  };
}

async function parseOptionalJsonBody(
  req: Request,
): Promise<{ ok: true; body: unknown | null } | { ok: false; response: Response }> {
  const raw = await req.text();
  if (!raw.trim()) return { ok: true, body: null };
  try {
    return { ok: true, body: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false, response: new Response("Malformed JSON", { status: 400 }) };
  }
}

function parseThreadIdPath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/threads\/([^/]+)$/);
  if (!match?.[1]) return null;
  return decodeURIComponent(match[1]);
}

function parseThreadArchivePath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/threads\/([^/]+)\/archive$/);
  if (!match?.[1]) return null;
  return decodeURIComponent(match[1]);
}

function parseThreadDismissOutcomePath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/threads\/([^/]+)\/dismiss-outcome$/);
  if (!match?.[1]) return null;
  return decodeURIComponent(match[1]);
}

function parseThreadMessagesPath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/threads\/([^/]+)\/messages$/);
  if (!match?.[1]) return null;
  return decodeURIComponent(match[1]);
}

function parseThreadSummariesPath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/threads\/([^/]+)\/summaries$/);
  if (!match?.[1]) return null;
  return decodeURIComponent(match[1]);
}

function parseThreadSeenPath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/threads\/([^/]+)\/seen$/);
  if (!match?.[1]) return null;
  return decodeURIComponent(match[1]);
}

// Named `dismiss-recent`, not `dismiss`: `/dismiss-outcome` above already means
// something unrelated (un-pinning a failures-only automaton thread from EVERY
// list). Two dismissals one hyphen apart is a miswiring waiting to happen.
function parseThreadDismissRecentPath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/threads\/([^/]+)\/dismiss-recent$/);
  if (!match?.[1]) return null;
  return decodeURIComponent(match[1]);
}

function parseThreadListStatus(
  value: string | null,
): { ok: true; value: "active" | "archived" | "all" } | { ok: false; response: Response } {
  if (value === null || value === "" || value === "active") return { ok: true, value: "active" };
  if (value === "archived" || value === "all") return { ok: true, value };
  return { ok: false, response: new Response("Invalid thread status", { status: 400 }) };
}

function parseThreadLimit(
  value: string | null,
): { ok: true; value: number | undefined } | { ok: false; response: Response } {
  // Absent means unbounded, deliberately: the deployed client sends no limit and
  // must keep getting the whole list.
  if (value === null || value === "") return { ok: true, value: undefined };
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return { ok: false, response: new Response("Invalid thread limit", { status: 400 }) };
  }
  return { ok: true, value: parsed };
}

function parseThreadProjectFilter(
  searchParams: URLSearchParams,
):
  | { ok: true; value: "all" | "unassigned" | { projectId: string } }
  | { ok: false; response: Response } {
  const project = searchParams.get("project");
  if (project !== null && project !== "unassigned") {
    return { ok: false, response: new Response("Invalid thread project filter", { status: 400 }) };
  }

  const projectId = searchParams.get("projectId");
  if (project === "unassigned" || projectId === "null") {
    return { ok: true, value: "unassigned" };
  }
  if (projectId && projectId.trim()) {
    return { ok: true, value: { projectId: projectId.trim() } };
  }
  return { ok: true, value: "all" };
}

const invalidJsonBody = Symbol("invalid_json_body");

function parseThreadTitlePatch(
  value: unknown,
):
  | { ok: true; hasValue: false }
  | { ok: true; hasValue: true; value: string }
  | { ok: false; response: Response } {
  if (value === undefined) return { ok: true, hasValue: false };
  if (typeof value !== "string")
    return { ok: false, response: new Response("title required", { status: 400 }) };
  const clean = value.trim().slice(0, MAX_TITLE_LEN);
  if (clean.length === 0)
    return { ok: false, response: new Response("title required", { status: 400 }) };
  return { ok: true, hasValue: true, value: clean };
}

function parseThreadReasoningEffortPatch(
  value: unknown,
):
  | { ok: true; hasValue: false }
  | { ok: true; hasValue: true; value: ReasoningEffort }
  | { ok: false; response: Response } {
  if (value === undefined) return { ok: true, hasValue: false };
  const parsed = parseReasoningEffort(value);
  if (!parsed) {
    return {
      ok: false,
      response: new Response("reasoningEffort must be one of off, low, medium, high", {
        status: 400,
      }),
    };
  }
  return { ok: true, hasValue: true, value: parsed };
}

async function resolveThreadProjectId(
  db: ReturnType<typeof registryDb>,
  workspaceId: string,
  input: ThreadModelSnapshotInput,
): Promise<{ ok: true; value: string | null } | { ok: false; response: Response }> {
  const project = await resolveThreadProjectPatch(db, workspaceId, input.projectId);
  if (!project.ok) return project;
  return { ok: true, value: project.hasValue ? project.value : null };
}

async function resolveThreadProjectPatch(
  db: ReturnType<typeof registryDb>,
  workspaceId: string,
  value: unknown,
): Promise<
  | { ok: true; hasValue: false }
  | { ok: true; hasValue: true; value: string | null }
  | { ok: false; response: Response }
> {
  if (value === undefined) return { ok: true, hasValue: false };
  if (value !== null && typeof value !== "string") {
    return {
      ok: false,
      response: new Response("projectId must be a string or null", { status: 400 }),
    };
  }
  if (value === null) return { ok: true, hasValue: true, value: null };

  const clean = value.trim();
  if (!clean) {
    return {
      ok: false,
      response: new Response("projectId must be a string or null", { status: 400 }),
    };
  }

  try {
    await new ProjectRepository(db).assertActiveProjectInWorkspace(clean, workspaceId);
    return { ok: true, hasValue: true, value: clean };
  } catch {
    return { ok: false, response: new Response("Not found", { status: 404 }) };
  }
}

/**
 * Resolves the `workbenchId` a newly created thread should snapshot from.
 * An explicit `workbenchId` on the request wins; otherwise it defaults to
 * the project's `defaultWorkbenchId` (null when there is no project or the
 * project has none set).
 */
async function resolveThreadWorkbenchId(
  db: ReturnType<typeof registryDb>,
  workspaceId: string,
  projectId: string | null,
  input: ThreadModelSnapshotInput,
): Promise<{ ok: true; value: string | null } | { ok: false; response: Response }> {
  const explicit = await resolveThreadWorkbenchPatch(db, workspaceId, input.workbenchId);
  if (!explicit.ok) return explicit;
  if (explicit.hasValue) return { ok: true, value: explicit.value };

  if (projectId === null) return { ok: true, value: null };
  const project = await new ProjectRepository(db).getById(projectId);
  const defaultWorkbenchId = project?.defaultWorkbenchId ?? null;
  if (defaultWorkbenchId === null) return { ok: true, value: null };

  // A stale project default (e.g. the workbench was archived after being
  // set as default) must not snapshot from it or 400 the thread create over
  // a default the caller never explicitly requested — fall back to null.
  try {
    await new WorkbenchRepository(db).assertActiveWorkbenchInWorkspace(
      defaultWorkbenchId,
      workspaceId,
    );
    return { ok: true, value: defaultWorkbenchId };
  } catch {
    return { ok: true, value: null };
  }
}

async function resolveThreadWorkbenchPatch(
  db: ReturnType<typeof registryDb>,
  workspaceId: string,
  value: unknown,
): Promise<
  | { ok: true; hasValue: false }
  | { ok: true; hasValue: true; value: string | null; name: string | null }
  | { ok: false; response: Response }
> {
  if (value === undefined) return { ok: true, hasValue: false };
  if (value !== null && typeof value !== "string") {
    return {
      ok: false,
      response: new Response("workbenchId must be a string or null", { status: 400 }),
    };
  }
  if (value === null) return { ok: true, hasValue: true, value: null, name: null };

  const clean = value.trim();
  if (!clean) {
    return {
      ok: false,
      response: new Response("workbenchId must be a string or null", { status: 400 }),
    };
  }

  try {
    // Loads and validates the row anyway, so returning its `name` alongside
    // the id (for the save-work message the live-sandbox switch path sends)
    // costs no extra query.
    const row = await new WorkbenchRepository(db).assertActiveWorkbenchInWorkspace(
      clean,
      workspaceId,
    );
    return { ok: true, hasValue: true, value: clean, name: row.name };
  } catch {
    return { ok: false, response: new Response("Not found", { status: 404 }) };
  }
}

/**
 * One thread, gated on membership alone.
 *
 * NOT a lookup into {@link selectThreadSummariesForUser}: that query carries the
 * sidebar-visibility predicate, which deliberately hides quiet-success threads of
 * a `failures_only` automaton (and any dismissed outcome). Hiding a thread from
 * the list must not make it unopenable — a direct link, a push notification, or
 * an outcome that was just dismissed all resolve a single thread by id.
 */
async function selectThreadSummaryForMember(
  env: Env,
  userId: string,
  threadId: string,
): Promise<ThreadSummary | null> {
  const db = registryDb(env);
  const row = await new ThreadRepository(db).getSummaryRowById(threadId);
  if (!row) return null;
  if (row.kind === "feedback") return null;

  try {
    await new WorkspaceRepository(db).assertMember({
      workspaceId: row.workspaceId,
      userId,
    });
  } catch {
    return null;
  }

  return serializeThread(row);
}

function isFeedbackThread(thread: { kind?: string | null }): boolean {
  return thread.kind === "feedback";
}

function parseThreadCompactPath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/threads\/([^/]+)\/compact$/);
  if (!match?.[1]) return null;
  return decodeURIComponent(match[1]);
}

function parseThreadCompactStatusPath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/threads\/([^/]+)\/compact\/status$/);
  if (!match?.[1]) return null;
  return decodeURIComponent(match[1]);
}
