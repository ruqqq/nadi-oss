import { SELF, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../src/db/schema";
import { applyRegistryTestSchema } from "./helpers/registry";

const now = 1_800_000_000_000;

async function seedUser(input?: { userId?: string; token?: string; workspaceId?: string }) {
  const db = drizzle(env.REGISTRY_DB, { schema });
  const userId = input?.userId ?? "user-hub";
  const token = input?.token ?? "hub-token";
  const workspaceId = input?.workspaceId ?? "workspace-hub";
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

async function clearRegistry() {
  const db = drizzle(env.REGISTRY_DB, { schema });
  await db.delete(schema.workspaceMembers);
  await db.delete(schema.sessions);
  await db.delete(schema.workspaces);
  await db.delete(schema.users);
}

describe("/live user hub", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });
  beforeEach(async () => {
    await clearRegistry();
  });

  it("rejects an unauthenticated upgrade with 401", async () => {
    const res = await SELF.fetch("https://nadi.test/live", { headers: { Upgrade: "websocket" } });
    expect(res.status).toBe(401);
  });

  it("delivers a published event to the user's connected socket", async () => {
    const seeded = await seedUser();
    const res = await SELF.fetch("https://nadi.test/live", {
      headers: { Upgrade: "websocket", cookie: `better-auth.session_token=${seeded.token}` },
    });
    expect(res.status).toBe(101);
    const ws = res.webSocket;
    expect(ws).toBeTruthy();
    ws!.accept();
    const received: string[] = [];
    ws!.addEventListener("message", (e) => {
      received.push(e.data as string);
    });

    const stub = env.USER_HUB.get(env.USER_HUB.idFromName(seeded.userId));
    await stub.publish({
      type: "thread.deleted",
      threadId: "thr_x",
      workspaceId: seeded.workspaceId,
    });

    await vi.waitFor(() => {
      expect(received).toHaveLength(1);
    });
    expect(JSON.parse(received[0]!)).toEqual({
      type: "thread.deleted",
      threadId: "thr_x",
      workspaceId: seeded.workspaceId,
    });
  });

  it("tracks visible active-thread presence per live socket", async () => {
    const seeded = await seedUser();
    const res = await SELF.fetch("https://nadi.test/live", {
      headers: { Upgrade: "websocket", cookie: `better-auth.session_token=${seeded.token}` },
    });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    ws.accept();
    ws.send(JSON.stringify({ type: "presence", activeThreadId: "thr_visible", visible: true }));

    const stub = env.USER_HUB.get(env.USER_HUB.idFromName(seeded.userId));
    await vi.waitFor(async () => {
      await expect(stub.hasVisibleThread("thr_visible")).resolves.toBe(true);
    });

    ws.send(JSON.stringify({ type: "presence", activeThreadId: "thr_visible", visible: false }));
    await vi.waitFor(async () => {
      await expect(stub.hasVisibleThread("thr_visible")).resolves.toBe(false);
    });
  });

  it("reports a visible client whatever thread it is on, for push suppression", async () => {
    const seeded = await seedUser();
    const res = await SELF.fetch("https://nadi.test/live", {
      headers: { Upgrade: "websocket", cookie: `better-auth.session_token=${seeded.token}` },
    });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    ws.accept();
    const stub = env.USER_HUB.get(env.USER_HUB.idFromName(seeded.userId));

    // On the chat list: no active thread at all, but very much in the app.
    ws.send(JSON.stringify({ type: "presence", activeThreadId: null, visible: true }));
    await vi.waitFor(async () => {
      await expect(stub.hasVisibleClient()).resolves.toBe(true);
    });
    // The narrow predicate must NOT follow it — it still drives unread state.
    await expect(stub.hasVisibleThread("thr_other")).resolves.toBe(false);

    ws.send(JSON.stringify({ type: "presence", activeThreadId: null, visible: false }));
    await vi.waitFor(async () => {
      await expect(stub.hasVisibleClient()).resolves.toBe(false);
    });
  });
});
