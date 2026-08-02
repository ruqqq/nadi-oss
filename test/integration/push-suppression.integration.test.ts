import { SELF, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../src/db/schema";
import { recordThreadLifecycleEvent } from "../../src/notifications/thread-notifications";
import { applyRegistryTestSchema } from "./helpers/registry";

/**
 * Injected rather than `vi.mock`ed: module mocking does not reach the module
 * under test inside the workers pool, so a mocked `web-push` left the real
 * (VAPID-less, no-op) sender running and made every assertion here vacuous.
 */
const sendWebPush = vi.fn(async () => "sent" as const);

const now = 1_800_000_000_000;
/** Comfortably past COMPLETION_PUSH_THRESHOLD_MS, so the duration gate passes. */
const LONG_TURN_MS = 60_000;

async function ensureThreadLifecycleSchema() {
  const columns = await env.REGISTRY_DB.prepare("PRAGMA table_info(thread_index)").all<{
    name: string;
  }>();
  const names = new Set(columns.results.map((column) => column.name));
  const additions: Array<[string, string]> = [
    ["activity_status", "text DEFAULT 'idle' NOT NULL"],
    ["current_turn_started_at", "integer"],
    ["attention_required_at", "integer"],
    ["unread_outcome", "text"],
    ["unread_outcome_at", "integer"],
    ["last_seen_at", "integer"],
  ];
  for (const [column, definition] of additions) {
    if (names.has(column)) continue;
    await env.REGISTRY_DB.prepare(
      `ALTER TABLE thread_index ADD COLUMN ${column} ${definition}`,
    ).run();
  }
}

/**
 * A fresh user per test, deliberately. The integration-fast project runs with
 * `isolate: false`, UserHub is keyed by user id, and nothing closes the sockets
 * an earlier test opened — so a shared id would carry a previous test's
 * `visible: true` presence into the next one and suppress a push it expects.
 */
async function seed(suffix: string) {
  const db = drizzle(env.REGISTRY_DB, { schema });
  const userId = `user-suppress-${suffix}`;
  const token = `suppress-token-${suffix}`;
  const workspaceId = `workspace-suppress-${suffix}`;
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
  await db.insert(schema.userNotificationSettings).values({
    userId,
    browserPushEnabled: true,
    pushPreviewEnabled: true,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.pushSubscriptions).values({
    id: `sub-suppress-${suffix}`,
    userId,
    endpoint: `https://push.test/${suffix}`,
    p256dh: "p256dh",
    auth: "auth",
    userAgent: null,
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await db
    .insert(schema.agents)
    .values({
      id: `agent-suppress-${suffix}`,
      workspaceId,
      name: "Default",
      systemPrompt: "You are Nadi.",
      provider: "mock",
      model: "mock",
      createdAt: now,
    })
    .onConflictDoNothing();
  for (const id of ["thr_target", "thr_other"]) {
    await db.insert(schema.threadIndex).values({
      id,
      workspaceId,
      agentId: `agent-suppress-${suffix}`,
      projectId: null,
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
  return { userId, token, workspaceId };
}

async function clearRegistry() {
  const db = drizzle(env.REGISTRY_DB, { schema });
  await db.delete(schema.threadIndex);
  await db.delete(schema.pushSubscriptions);
  await db.delete(schema.userNotificationSettings);
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
  return ws;
}

async function completeTargetThread(workspaceId: string, preview?: string) {
  await recordThreadLifecycleEvent({
    env,
    event: {
      type: "thread.completed",
      threadId: "thr_target",
      workspaceId,
      startedAt: now,
      occurredAt: now + LONG_TURN_MS,
      hadWatchedWork: false,
      ...(preview ? { preview } : {}),
    },
    sendPush: sendWebPush,
  });
}

/**
 * An OS notification for someone who is already looking at Nadi is noise — and
 * on an installed iOS PWA it is worse, because WebKit does not fire
 * `notificationclick` while the app is running, so the banner cannot even be
 * tapped. The server therefore declines to send one at all.
 */
describe("push suppression while the user is in the app", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
    await ensureThreadLifecycleSchema();
  });

  beforeEach(async () => {
    sendWebPush.mockClear();
    await clearRegistry();
  });

  it("suppresses the push when the user is visible on a DIFFERENT thread", async () => {
    const seeded = await seed("different");
    const ws = await openLive(seeded.token);
    ws.send(JSON.stringify({ type: "presence", activeThreadId: "thr_other", visible: true }));
    await vi.waitFor(async () => {
      const stub = env.USER_HUB.get(env.USER_HUB.idFromName(seeded.userId));
      await expect(stub.hasVisibleClient()).resolves.toBe(true);
    });

    await completeTargetThread(seeded.workspaceId);

    expect(sendWebPush).not.toHaveBeenCalled();
  });

  it("suppresses the push when the user is visible on no thread at all", async () => {
    const seeded = await seed("nothread");
    const ws = await openLive(seeded.token);
    ws.send(JSON.stringify({ type: "presence", activeThreadId: null, visible: true }));
    await vi.waitFor(async () => {
      const stub = env.USER_HUB.get(env.USER_HUB.idFromName(seeded.userId));
      await expect(stub.hasVisibleClient()).resolves.toBe(true);
    });

    await completeTargetThread(seeded.workspaceId);

    expect(sendWebPush).not.toHaveBeenCalled();
  });

  it("still sends when a tab is visible but nobody is at it", async () => {
    // The reported failure: a laptop tab left frontmost heartbeats `visible`
    // forever, and per-user suppression turned that into silence on every
    // device the account owns.
    const seeded = await seed("idle");
    const ws = await openLive(seeded.token);
    ws.send(
      JSON.stringify({
        type: "presence",
        activeThreadId: "thr_other",
        visible: true,
        active: false,
      }),
    );
    await vi.waitFor(async () => {
      const stub = env.USER_HUB.get(env.USER_HUB.idFromName(seeded.userId));
      await expect(stub.hasVisibleClient()).resolves.toBe(false);
      // Still visible for unread purposes — the two questions stay separate.
      await expect(stub.hasVisibleThread("thr_other")).resolves.toBe(true);
    });

    await completeTargetThread(seeded.workspaceId);

    expect(sendWebPush).toHaveBeenCalledTimes(1);
  });

  it("suppresses when the client reports it is being used", async () => {
    const seeded = await seed("activeuse");
    const ws = await openLive(seeded.token);
    ws.send(
      JSON.stringify({ type: "presence", activeThreadId: null, visible: true, active: true }),
    );
    await vi.waitFor(async () => {
      const stub = env.USER_HUB.get(env.USER_HUB.idFromName(seeded.userId));
      await expect(stub.hasVisibleClient()).resolves.toBe(true);
    });

    await completeTargetThread(seeded.workspaceId);

    expect(sendWebPush).not.toHaveBeenCalled();
  });

  it("still sends when the app is open but hidden — that is what push is for", async () => {
    const seeded = await seed("hidden");
    const ws = await openLive(seeded.token);
    ws.send(JSON.stringify({ type: "presence", activeThreadId: "thr_other", visible: false }));
    await vi.waitFor(async () => {
      const stub = env.USER_HUB.get(env.USER_HUB.idFromName(seeded.userId));
      await expect(stub.hasVisibleClient()).resolves.toBe(false);
    });

    await completeTargetThread(seeded.workspaceId);

    expect(sendWebPush).toHaveBeenCalledTimes(1);
  });

  it("still sends when the user has no live client at all", async () => {
    const seeded = await seed("noclient");

    await completeTargetThread(seeded.workspaceId);

    expect(sendWebPush).toHaveBeenCalledTimes(1);
  });

  it("puts the push excerpt on the live broadcast, for the in-app notice", async () => {
    // The in-app toast must be able to say what the push would have said. The
    // thread row cannot supply it: `lastMessagePreview` is written by the search
    // projector from ctx.waitUntil and races this broadcast.
    const seeded = await seed("preview");
    const ws = await openLive(seeded.token);
    const received: Array<Record<string, unknown>> = [];
    ws.addEventListener("message", (e) => received.push(JSON.parse(e.data as string)));
    ws.send(JSON.stringify({ type: "presence", activeThreadId: null, visible: true }));
    await vi.waitFor(async () => {
      const stub = env.USER_HUB.get(env.USER_HUB.idFromName(seeded.userId));
      await expect(stub.hasVisibleClient()).resolves.toBe(true);
    });

    await completeTargetThread(seeded.workspaceId, "Migrated 14 rows and re-ran the suite.");

    await vi.waitFor(() => {
      expect(received.some((event) => event.type === "thread.updated")).toBe(true);
    });
    const updated = received.find((event) => event.type === "thread.updated");
    expect(updated?.preview).toBe("Migrated 14 rows and re-ran the suite.");
  });

  it("omits the preview when the turn produced no prose", async () => {
    const seeded = await seed("nopreview");
    const ws = await openLive(seeded.token);
    const received: Array<Record<string, unknown>> = [];
    ws.addEventListener("message", (e) => received.push(JSON.parse(e.data as string)));

    await completeTargetThread(seeded.workspaceId);

    await vi.waitFor(() => {
      expect(received.some((event) => event.type === "thread.updated")).toBe(true);
    });
    expect(received.find((event) => event.type === "thread.updated")).not.toHaveProperty("preview");
  });

  it("still marks the thread unread — suppression costs the banner, not the record", async () => {
    const seeded = await seed("unread");
    const ws = await openLive(seeded.token);
    // Visible, but on another thread: the completed one was never read.
    ws.send(JSON.stringify({ type: "presence", activeThreadId: "thr_other", visible: true }));
    await vi.waitFor(async () => {
      const stub = env.USER_HUB.get(env.USER_HUB.idFromName(seeded.userId));
      await expect(stub.hasVisibleClient()).resolves.toBe(true);
    });

    await completeTargetThread(seeded.workspaceId);

    const db = drizzle(env.REGISTRY_DB, { schema });
    const row = await db
      .select()
      .from(schema.threadIndex)
      .where(eq(schema.threadIndex.id, "thr_target"))
      .get();
    expect(row?.unreadOutcome).toBe("completed");
  });
});
