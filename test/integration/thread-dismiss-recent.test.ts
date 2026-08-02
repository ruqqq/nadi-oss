import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { applyRegistryTestSchema } from "./helpers/registry";
import { routeThreads, selectThreadSummariesForUser } from "../../src/http/thread-routes";
import type { Env } from "../../src/env";

const now = 1_800_000_000_000;

function makeExecutionContext(): ExecutionContext {
  return { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
}

async function clearRegistry() {
  const db = drizzle(env.REGISTRY_DB, { schema });
  await db.delete(schema.threadRepositorySnapshots);
  await db.delete(schema.threadIndex);
  await db.delete(schema.automata);
  await db.delete(schema.agents);
  await db.delete(schema.workspaceMembers);
  await db.delete(schema.workspaces);
  await db.delete(schema.sessions);
  await db.delete(schema.users);
}

async function seedUserWorkspace(input: { userId: string; token: string; workspaceId: string }) {
  const db = drizzle(env.REGISTRY_DB, { schema });
  const { userId, token, workspaceId } = input;
  const agentId = `agent-${workspaceId}`;

  await db.insert(schema.users).values({
    id: userId,
    email: `${userId}@example.com`,
    name: null,
    createdAt: new Date(now),
    emailVerified: true,
    image: null,
    updatedAt: new Date(now),
  });
  await db.insert(schema.sessions).values({
    id: `session-${userId}`,
    userId,
    token,
    expiresAt: new Date(now + 60_000),
    createdAt: new Date(now),
    updatedAt: new Date(now),
    ipAddress: null,
    userAgent: null,
  });
  await db.insert(schema.workspaces).values({ id: workspaceId, name: workspaceId, createdAt: now });
  await db.insert(schema.workspaceMembers).values({
    workspaceId,
    userId,
    role: "owner",
    createdAt: now,
  });
  await db.insert(schema.agents).values({
    id: agentId,
    workspaceId,
    name: "Default",
    systemPrompt: "You are Nadi.",
    provider: "mock",
    model: "mock",
    modelInputModalities: JSON.stringify(["text"]),
    showReasoning: true,
    createdAt: now,
  });

  return { userId, token, workspaceId, agentId };
}

async function insertThread(input: {
  id: string;
  workspaceId: string;
  agentId: string;
  activityStatus?: "idle" | "running" | "attention_required" | "failed";
  unreadOutcome?: "completed" | "failed" | null;
  recentDismissedAt?: number | null;
  updatedAt: number;
}) {
  const db = drizzle(env.REGISTRY_DB, { schema });
  await db.insert(schema.threadIndex).values({
    id: input.id,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    title: input.id,
    runtime: "think",
    source: "manual",
    automatonId: null,
    automatonRunId: null,
    lastEventId: null,
    lastMessagePreview: "",
    activityStatus: input.activityStatus ?? "idle",
    unreadOutcome: input.unreadOutcome ?? null,
    unreadOutcomeAt: input.unreadOutcome ? input.updatedAt : null,
    recentDismissedAt: input.recentDismissedAt ?? null,
    createdAt: input.updatedAt,
    updatedAt: input.updatedAt,
  });
}

async function readThread(threadId: string) {
  const db = drizzle(env.REGISTRY_DB, { schema });
  const row = await db
    .select()
    .from(schema.threadIndex)
    .where(eq(schema.threadIndex.id, threadId))
    .get();
  if (!row) throw new Error(`thread ${threadId} not found`);
  return row;
}

function request(threadId: string, method: "POST" | "DELETE" | "GET", token: string) {
  return new Request(`https://nadi.test/api/threads/${threadId}/dismiss-recent`, {
    method,
    headers: { cookie: `better-auth.session_token=${token}` },
  });
}

describe("/api/threads/:id/dismiss-recent", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  beforeEach(async () => {
    await clearRegistry();
  });

  afterEach(async () => {
    await clearRegistry();
  });

  it("POST stamps recentDismissedAt and leaves updatedAt untouched", async () => {
    const { userId, token, workspaceId, agentId } = await seedUserWorkspace({
      userId: "user-recent",
      token: "recent-token",
      workspaceId: "workspace-recent",
    });
    const threadId = "thr_recent_dismiss";
    const updatedAt = now + 1;
    await insertThread({ id: threadId, workspaceId, agentId, updatedAt });

    const res = await routeThreads(
      request(threadId, "POST", token),
      env as unknown as Env,
      makeExecutionContext(),
    );
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { thread: { recentDismissedAt: number | null } };
    expect(body.thread.recentDismissedAt).not.toBeNull();

    const row = await readThread(threadId);
    expect(row.recentDismissedAt).not.toBeNull();
    // The rail hides a thread only while recentDismissedAt >= updatedAt, so a
    // bump here would expire the dismissal in the same statement that created
    // it and the whole feature would silently do nothing.
    expect(row.updatedAt).toBe(updatedAt);

    // Dismissal is a rail-only concern: the thread stays in the list every
    // other surface reads from.
    const rows = await selectThreadSummariesForUser(env as unknown as Env, userId);
    expect(rows.threads.some((r) => r.threadId === threadId)).toBe(true);
  });

  it("DELETE clears the stamp and still leaves updatedAt untouched", async () => {
    const { token, workspaceId, agentId } = await seedUserWorkspace({
      userId: "user-recent-undo",
      token: "recent-undo-token",
      workspaceId: "workspace-recent-undo",
    });
    const threadId = "thr_recent_undo";
    const updatedAt = now + 2;
    await insertThread({
      id: threadId,
      workspaceId,
      agentId,
      updatedAt,
      recentDismissedAt: updatedAt + 5,
    });

    const res = await routeThreads(
      request(threadId, "DELETE", token),
      env as unknown as Env,
      makeExecutionContext(),
    );
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { thread: { recentDismissedAt: number | null } };
    expect(body.thread.recentDismissedAt).toBeNull();

    const row = await readThread(threadId);
    expect(row.recentDismissedAt).toBeNull();
    expect(row.updatedAt).toBe(updatedAt);
  });

  it("returns 404 for a thread in a workspace the caller is not a member of", async () => {
    const { token } = await seedUserWorkspace({
      userId: "user-recent-caller",
      token: "recent-caller-token",
      workspaceId: "workspace-recent-caller",
    });
    const other = await seedUserWorkspace({
      userId: "user-recent-other",
      token: "recent-other-token",
      workspaceId: "workspace-recent-other",
    });
    const threadId = "thr_recent_other";
    await insertThread({
      id: threadId,
      workspaceId: other.workspaceId,
      agentId: other.agentId,
      updatedAt: now + 3,
    });

    const res = await routeThreads(
      request(threadId, "POST", token),
      env as unknown as Env,
      makeExecutionContext(),
    );
    expect(res?.status).toBe(404);

    const row = await readThread(threadId);
    expect(row.recentDismissedAt).toBeNull();
  });

  it("rejects methods other than POST and DELETE", async () => {
    const { token, workspaceId, agentId } = await seedUserWorkspace({
      userId: "user-recent-method",
      token: "recent-method-token",
      workspaceId: "workspace-recent-method",
    });
    const threadId = "thr_recent_method";
    await insertThread({ id: threadId, workspaceId, agentId, updatedAt: now + 4 });

    const res = await routeThreads(
      request(threadId, "GET", token),
      env as unknown as Env,
      makeExecutionContext(),
    );
    expect(res?.status).toBe(405);
  });
});

describe("POST /api/threads/:id/seen", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  beforeEach(async () => {
    await clearRegistry();
  });

  afterEach(async () => {
    await clearRegistry();
  });

  it("clears the unread outcome without demoting a failed activityStatus", async () => {
    const { token, workspaceId, agentId } = await seedUserWorkspace({
      userId: "user-seen",
      token: "seen-token",
      workspaceId: "workspace-seen",
    });
    const threadId = "thr_seen_failed";
    await insertThread({
      id: threadId,
      workspaceId,
      agentId,
      activityStatus: "failed",
      unreadOutcome: "failed",
      updatedAt: now + 5,
    });

    const res = await routeThreads(
      new Request(`https://nadi.test/api/threads/${threadId}/seen`, {
        method: "POST",
        headers: { cookie: `better-auth.session_token=${token}` },
      }),
      env as unknown as Env,
      makeExecutionContext(),
    );
    expect(res?.status).toBe(200);

    const row = await readThread(threadId);
    expect(row.unreadOutcome).toBeNull();
    expect(row.unreadOutcomeAt).toBeNull();
    expect(row.lastSeenAt).not.toBeNull();
    // Acknowledging must NOT write activityStatus. Its only consumer is the
    // failures-only visibility rule, where a failed automaton thread is listed
    // BECAUSE it failed — demoting it here would delete the thread from All
    // chats as well as the rail.
    expect(row.activityStatus).toBe("failed");
  });
});
