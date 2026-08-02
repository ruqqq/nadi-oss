import { SELF, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../src/db/schema";
import { recordThreadLifecycleEvent } from "../../src/notifications/thread-notifications";
import { applyRegistryTestSchema } from "./helpers/registry";

const now = 1_800_000_000_000;

async function ensureThreadLifecycleSchema() {
  const threadColumns = await env.REGISTRY_DB.prepare("PRAGMA table_info(thread_index)").all<{
    name: string;
  }>();
  const threadColumnNames = new Set(threadColumns.results.map((column) => column.name));
  if (!threadColumnNames.has("activity_status")) {
    await env.REGISTRY_DB.prepare(
      "ALTER TABLE thread_index ADD COLUMN activity_status text DEFAULT 'idle' NOT NULL",
    ).run();
  }
  if (!threadColumnNames.has("current_turn_started_at")) {
    await env.REGISTRY_DB.prepare(
      "ALTER TABLE thread_index ADD COLUMN current_turn_started_at integer",
    ).run();
  }
  if (!threadColumnNames.has("attention_required_at")) {
    await env.REGISTRY_DB.prepare(
      "ALTER TABLE thread_index ADD COLUMN attention_required_at integer",
    ).run();
  }
  if (!threadColumnNames.has("unread_outcome")) {
    await env.REGISTRY_DB.prepare("ALTER TABLE thread_index ADD COLUMN unread_outcome text").run();
  }
  if (!threadColumnNames.has("unread_outcome_at")) {
    await env.REGISTRY_DB.prepare(
      "ALTER TABLE thread_index ADD COLUMN unread_outcome_at integer",
    ).run();
  }
  if (!threadColumnNames.has("last_seen_at")) {
    await env.REGISTRY_DB.prepare("ALTER TABLE thread_index ADD COLUMN last_seen_at integer").run();
  }
}

async function seedUser() {
  const db = drizzle(env.REGISTRY_DB, { schema });
  const userId = "user-bcast";
  const token = "bcast-token";
  const workspaceId = "workspace-bcast";
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
  await db
    .insert(schema.workspaceMembers)
    .values({ workspaceId, userId, role: "owner", createdAt: now });
  return { userId, token, workspaceId };
}

async function insertThread(input: { id: string; workspaceId: string; projectId?: string }) {
  const db = drizzle(env.REGISTRY_DB, { schema });
  // Miniflare D1 enforces FK constraints: agent row must exist before thread row.
  await db
    .insert(schema.agents)
    .values({
      id: "agent-bcast",
      workspaceId: input.workspaceId,
      name: "Default",
      systemPrompt: "You are Nadi.",
      provider: "mock",
      model: "mock",
      createdAt: now,
    })
    .onConflictDoNothing();
  await db.insert(schema.threadIndex).values({
    id: input.id,
    workspaceId: input.workspaceId,
    agentId: "agent-bcast",
    projectId: input.projectId ?? null,
    title: "Seed",
    titleSet: false,
    source: "manual",
    automatonId: null,
    automatonRunId: null,
    lastEventId: null,
    lastMessagePreview: "",
    createdAt: now,
    updatedAt: now,
  });
}

async function insertProject(input: { id: string; workspaceId: string; name: string }) {
  const db = drizzle(env.REGISTRY_DB, { schema });
  await db.insert(schema.projects).values({
    id: input.id,
    workspaceId: input.workspaceId,
    name: input.name,
    description: "",
    customInstructions: "",
    createdAt: now,
    updatedAt: now,
  });
}

async function clearRegistry() {
  const db = drizzle(env.REGISTRY_DB, { schema });
  await db.delete(schema.threadIndex);
  await db.delete(schema.projects);
  await db.delete(schema.agents);
  await db.delete(schema.workspaceMembers);
  await db.delete(schema.sessions);
  await db.delete(schema.workspaces);
  await db.delete(schema.users);
}

async function openLive(token: string) {
  const res = await SELF.fetch("https://nadi.test/live", {
    headers: { Upgrade: "websocket", cookie: `better-auth.session_token=${token}` },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  const received: unknown[] = [];
  ws.addEventListener("message", (e) => {
    received.push(JSON.parse(e.data as string));
  });
  return { received };
}

describe("thread events broadcast to /live", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
    await ensureThreadLifecycleSchema();
  });
  beforeEach(async () => {
    await clearRegistry();
  });

  it("broadcasts thread.deleted when a thread is deleted", async () => {
    const seeded = await seedUser();
    await insertThread({ id: "thr_del", workspaceId: seeded.workspaceId });
    const live = await openLive(seeded.token);

    const res = await SELF.fetch("https://nadi.test/api/threads/thr_del", {
      method: "DELETE",
      headers: { cookie: `better-auth.session_token=${seeded.token}` },
    });
    expect(res.status).toBe(204);

    await vi.waitFor(() => {
      expect(live.received).toHaveLength(1);
    });
    expect(live.received[0]).toEqual({
      type: "thread.deleted",
      threadId: "thr_del",
      workspaceId: seeded.workspaceId,
    });
  });

  it("broadcasts thread.updated when a thread is renamed", async () => {
    const seeded = await seedUser();
    await insertThread({ id: "thr_ren", workspaceId: seeded.workspaceId });
    const live = await openLive(seeded.token);

    const res = await SELF.fetch("https://nadi.test/api/threads/thr_ren", {
      method: "PATCH",
      headers: {
        cookie: `better-auth.session_token=${seeded.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "Renamed" }),
    });
    expect(res.status).toBe(200);

    await vi.waitFor(() => {
      expect(live.received).toHaveLength(1);
    });
    expect(live.received[0]).toMatchObject({
      type: "thread.updated",
      thread: { threadId: "thr_ren", title: "Renamed", workspaceId: seeded.workspaceId },
    });
  });

  it("broadcasts thread.updated when lifecycle state changes to running", async () => {
    const seeded = await seedUser();
    await insertThread({ id: "thr_run", workspaceId: seeded.workspaceId });
    const live = await openLive(seeded.token);

    await recordThreadLifecycleEvent({
      env,
      event: {
        type: "thread.started",
        threadId: "thr_run",
        workspaceId: seeded.workspaceId,
        startedAt: now + 50,
      },
    });

    await vi.waitFor(() => {
      expect(live.received).toHaveLength(1);
    });
    expect(live.received[0]).toMatchObject({
      type: "thread.updated",
      thread: {
        threadId: "thr_run",
        workspaceId: seeded.workspaceId,
        activityStatus: "running",
        currentTurnStartedAt: now + 50,
      },
    });
  });

  it("keeps the project name on a lifecycle broadcast so the sidebar chip survives", async () => {
    const seeded = await seedUser();
    await insertProject({ id: "proj_bcast", workspaceId: seeded.workspaceId, name: "Acme" });
    await insertThread({
      id: "thr_proj",
      workspaceId: seeded.workspaceId,
      projectId: "proj_bcast",
    });
    const live = await openLive(seeded.token);

    // A bare threadIndex serialization would broadcast projectName: null, and the
    // client's whole-object merge would drop the chip until the next refetch.
    await recordThreadLifecycleEvent({
      env,
      event: {
        type: "thread.started",
        threadId: "thr_proj",
        workspaceId: seeded.workspaceId,
        startedAt: now + 50,
      },
    });

    await vi.waitFor(() => {
      expect(live.received).toHaveLength(1);
    });
    expect(live.received[0]).toMatchObject({
      type: "thread.updated",
      thread: {
        threadId: "thr_proj",
        projectId: "proj_bcast",
        projectName: "Acme",
      },
    });
  });
});
