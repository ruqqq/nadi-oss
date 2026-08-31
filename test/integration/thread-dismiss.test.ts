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
  automatonId?: string | null;
  activityStatus?: "idle" | "running" | "attention_required" | "failed";
  updatedAt: number;
}) {
  const db = drizzle(env.REGISTRY_DB, { schema });
  await db.insert(schema.threadIndex).values({
    id: input.id,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    title: input.id,
    runtime: "think",
    source: input.automatonId ? "automaton" : "manual",
    automatonId: input.automatonId ?? null,
    automatonRunId: null,
    lastEventId: null,
    lastMessagePreview: "",
    activityStatus: input.activityStatus ?? "idle",
    createdAt: input.updatedAt,
    updatedAt: input.updatedAt,
  });
}

describe("POST /api/threads/:id/dismiss-outcome", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  beforeEach(async () => {
    await clearRegistry();
  });

  afterEach(async () => {
    await clearRegistry();
  });

  it("dismissing a failed failures_only automaton thread removes it from the sidebar list", async () => {
    const { userId, token, workspaceId, agentId } = await seedUserWorkspace({
      userId: "user-dismiss",
      token: "dismiss-token",
      workspaceId: "workspace-dismiss",
    });
    await insertAutomaton({
      id: "automaton-dismiss",
      workspaceId,
      ownerUserId: userId,
      agentId,
      notifyMode: "failures_only",
    });
    const failuresOnlyFailed = "thr_dismiss_failed";
    await insertThread({
      id: failuresOnlyFailed,
      workspaceId,
      agentId,
      automatonId: "automaton-dismiss",
      activityStatus: "failed",
      updatedAt: now + 1,
    });

    const rowsBefore = await selectThreadSummariesForUser(env as unknown as Env, userId);
    expect(rowsBefore.threads.some((r) => r.threadId === failuresOnlyFailed)).toBe(true);

    const res = await routeThreads(
      new Request(`https://nadi.test/api/threads/${failuresOnlyFailed}/dismiss-outcome`, {
        method: "POST",
        headers: { cookie: `better-auth.session_token=${token}` },
      }),
      env as unknown as Env,
      makeExecutionContext(),
    );
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { thread: { threadId: string } };
    expect(body.thread.threadId).toBe(failuresOnlyFailed);

    const rowsAfter = await selectThreadSummariesForUser(env as unknown as Env, userId);
    expect(rowsAfter.threads.some((r) => r.threadId === failuresOnlyFailed)).toBe(false);
  });

  it("dismiss requires membership and returns 404 for a workspace the caller is not in", async () => {
    const { token } = await seedUserWorkspace({
      userId: "user-dismiss-caller",
      token: "dismiss-caller-token",
      workspaceId: "workspace-dismiss-caller",
    });
    const other = await seedUserWorkspace({
      userId: "user-dismiss-other",
      token: "dismiss-other-token",
      workspaceId: "workspace-dismiss-other",
    });
    const otherWorkspaceThread = "thr_dismiss_other";
    await insertThread({
      id: otherWorkspaceThread,
      workspaceId: other.workspaceId,
      agentId: other.agentId,
      activityStatus: "failed",
      updatedAt: now + 1,
    });

    const res = await routeThreads(
      new Request(`https://nadi.test/api/threads/${otherWorkspaceThread}/dismiss-outcome`, {
        method: "POST",
        headers: { cookie: `better-auth.session_token=${token}` },
      }),
      env as unknown as Env,
      makeExecutionContext(),
    );
    expect(res?.status).toBe(404);
  });
});
