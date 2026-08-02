import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
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
  await db.insert(schema.workspaces).values({
    id: workspaceId,
    name: workspaceId,
    createdAt: now,
  });
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

async function insertAutomaton(input: {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  agentId: string;
  notifyMode: "all" | "failures_only";
}) {
  const db = drizzle(env.REGISTRY_DB, { schema });
  await db.insert(schema.automata).values({
    id: input.id,
    workspaceId: input.workspaceId,
    ownerUserId: input.ownerUserId,
    agentId: input.agentId,
    name: input.id,
    prompt: "Do the thing",
    scheduleJson: JSON.stringify({ kind: "manual" }),
    timezone: "UTC",
    enabled: true,
    notifyMode: input.notifyMode,
    createdAt: now,
    updatedAt: now,
  });
}

async function insertThread(input: {
  id: string;
  workspaceId: string;
  agentId: string;
  automatonId: string;
  updatedAt: number;
}) {
  const db = drizzle(env.REGISTRY_DB, { schema });
  await db.insert(schema.threadIndex).values({
    id: input.id,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    title: input.id,
    runtime: "think",
    source: "automaton",
    automatonId: input.automatonId,
    automatonRunId: null,
    lastEventId: null,
    lastMessagePreview: "",
    activityStatus: "idle",
    createdAt: input.updatedAt,
    updatedAt: input.updatedAt,
  });
}

function getThread(threadId: string, token: string) {
  return routeThreads(
    new Request(`https://nadi.test/api/threads/${threadId}`, {
      headers: { cookie: `better-auth.session_token=${token}` },
    }),
    env as unknown as Env,
    makeExecutionContext(),
  );
}

describe("GET /api/threads/:id", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  beforeEach(async () => {
    await clearRegistry();
  });

  afterEach(async () => {
    await clearRegistry();
  });

  it("opens a sidebar-hidden failures_only automaton thread by id", async () => {
    const { userId, token, workspaceId, agentId } = await seedUserWorkspace({
      userId: "user-get-hidden",
      token: "get-hidden-token",
      workspaceId: "workspace-get-hidden",
    });
    await insertAutomaton({
      id: "automaton-quiet",
      workspaceId,
      ownerUserId: userId,
      agentId,
      notifyMode: "failures_only",
    });
    const threadId = "thr_quiet_success";
    await insertThread({
      id: threadId,
      workspaceId,
      agentId,
      automatonId: "automaton-quiet",
      updatedAt: now + 1,
    });

    // The sidebar deliberately hides it; a direct link must still open it.
    const listed = await selectThreadSummariesForUser(env as unknown as Env, userId);
    expect(listed.threads.some((r) => r.threadId === threadId)).toBe(false);

    const res = await getThread(threadId, token);
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as {
      thread: { threadId: string; automatonNotifyMode: string | null };
    };
    expect(body.thread.threadId).toBe(threadId);
    expect(body.thread.automatonNotifyMode).toBe("failures_only");
  });

  it("still 404s a thread in a workspace the caller does not belong to", async () => {
    const other = await seedUserWorkspace({
      userId: "user-other",
      token: "other-token",
      workspaceId: "workspace-other",
    });
    const mine = await seedUserWorkspace({
      userId: "user-mine",
      token: "mine-token",
      workspaceId: "workspace-mine",
    });
    await insertAutomaton({
      id: "automaton-other",
      workspaceId: other.workspaceId,
      ownerUserId: other.userId,
      agentId: other.agentId,
      notifyMode: "failures_only",
    });
    const threadId = "thr_other_workspace";
    await insertThread({
      id: threadId,
      workspaceId: other.workspaceId,
      agentId: other.agentId,
      automatonId: "automaton-other",
      updatedAt: now + 1,
    });

    const res = await getThread(threadId, mine.token);
    expect(res?.status).toBe(404);
  });
});
