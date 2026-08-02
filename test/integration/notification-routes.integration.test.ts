import { SELF, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { applyRegistryTestSchema } from "./helpers/registry";

const now = 1_800_000_000_000;

function cookie(token: string) {
  return { cookie: `better-auth.session_token=${token}` };
}

async function ensureNotificationSchema() {
  const statements = [
    "CREATE TABLE IF NOT EXISTS push_subscriptions (id text PRIMARY KEY NOT NULL, user_id text NOT NULL, endpoint text NOT NULL, p256dh text NOT NULL, auth text NOT NULL, user_agent text, created_at integer NOT NULL, updated_at integer NOT NULL, last_seen_at integer NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id))",
    "CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions (user_id)",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_push_subscriptions_endpoint ON push_subscriptions (endpoint)",
    "CREATE TABLE IF NOT EXISTS user_notification_settings (user_id text PRIMARY KEY NOT NULL, browser_push_enabled integer DEFAULT false NOT NULL, push_preview_enabled integer DEFAULT true NOT NULL, created_at integer NOT NULL, updated_at integer NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id))",
  ];
  for (const statement of statements) {
    await env.REGISTRY_DB.prepare(statement).run();
  }
}

async function clearRegistry() {
  const db = drizzle(env.REGISTRY_DB, { schema });
  await db.delete(schema.pushSubscriptions);
  await db.delete(schema.userNotificationSettings);
  await db.delete(schema.workspaceMembers);
  await db.delete(schema.workspaces);
  await db.delete(schema.sessions);
  await db.delete(schema.users);
}

async function seedUser() {
  const db = drizzle(env.REGISTRY_DB, { schema });
  const userId = "user-notifications";
  const token = "notifications-token";

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

  return { userId, token };
}

describe("notification routes", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
    await ensureNotificationSchema();
  });

  beforeEach(async () => {
    await ensureNotificationSchema();
    await clearRegistry();
  });

  it("rejects unauthenticated browser notification requests", async () => {
    const res = await SELF.fetch("https://nadi.test/api/notifications/browser");

    expect(res.status).toBe(401);
  });

  it("returns default browser notification settings", async () => {
    const seeded = await seedUser();
    const res = await SELF.fetch("https://nadi.test/api/notifications/browser", {
      headers: cookie(seeded.token),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      browserPushEnabled: false,
      vapidPublicKey: null,
    });
  });

  it("updates browser notification settings", async () => {
    const seeded = await seedUser();
    const res = await SELF.fetch("https://nadi.test/api/notifications/browser/settings", {
      method: "PUT",
      headers: {
        ...cookie(seeded.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({ browserPushEnabled: true }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      browserPushEnabled: true,
      vapidPublicKey: null,
    });

    const db = drizzle(env.REGISTRY_DB, { schema });
    await expect(
      db
        .select()
        .from(schema.userNotificationSettings)
        .where(eq(schema.userNotificationSettings.userId, seeded.userId))
        .get(),
    ).resolves.toMatchObject({ browserPushEnabled: true });
  });

  it("defaults reply previews to on", async () => {
    const seeded = await seedUser();
    const res = await SELF.fetch("https://nadi.test/api/notifications/browser", {
      headers: cookie(seeded.token),
    });

    await expect(res.json()).resolves.toMatchObject({ pushPreviewEnabled: true });
  });

  it("turns previews off without disturbing the push toggle", async () => {
    const seeded = await seedUser();
    const settings = async (body: unknown) =>
      SELF.fetch("https://nadi.test/api/notifications/browser/settings", {
        method: "PUT",
        headers: { ...cookie(seeded.token), "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    await settings({ browserPushEnabled: true });
    const res = await settings({ pushPreviewEnabled: false });

    expect(res.status).toBe(200);
    // The response echoes both fields, so a client sending one switch still
    // learns the true state of the other.
    await expect(res.json()).resolves.toMatchObject({
      browserPushEnabled: true,
      pushPreviewEnabled: false,
    });

    const db = drizzle(env.REGISTRY_DB, { schema });
    await expect(
      db
        .select()
        .from(schema.userNotificationSettings)
        .where(eq(schema.userNotificationSettings.userId, seeded.userId))
        .get(),
    ).resolves.toMatchObject({ browserPushEnabled: true, pushPreviewEnabled: false });
  });

  it("leaves previews alone when only the push toggle is sent", async () => {
    const seeded = await seedUser();
    const settings = async (body: unknown) =>
      SELF.fetch("https://nadi.test/api/notifications/browser/settings", {
        method: "PUT",
        headers: { ...cookie(seeded.token), "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    await settings({ pushPreviewEnabled: false });
    const res = await settings({ browserPushEnabled: true });

    await expect(res.json()).resolves.toMatchObject({
      browserPushEnabled: true,
      pushPreviewEnabled: false,
    });
  });

  it("rejects a settings update with nothing to update", async () => {
    const seeded = await seedUser();
    const res = await SELF.fetch("https://nadi.test/api/notifications/browser/settings", {
      method: "PUT",
      headers: { ...cookie(seeded.token), "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });

  it("rejects a non-boolean preview setting", async () => {
    const seeded = await seedUser();
    const res = await SELF.fetch("https://nadi.test/api/notifications/browser/settings", {
      method: "PUT",
      headers: { ...cookie(seeded.token), "content-type": "application/json" },
      body: JSON.stringify({ pushPreviewEnabled: "no" }),
    });

    expect(res.status).toBe(400);
  });

  it("rejects invalid subscription payloads", async () => {
    const seeded = await seedUser();
    const res = await SELF.fetch("https://nadi.test/api/notifications/browser/subscriptions", {
      method: "POST",
      headers: {
        ...cookie(seeded.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        endpoint: "http://invalid.example/sub",
        keys: { p256dh: "p", auth: "a" },
      }),
    });

    expect(res.status).toBe(400);
  });

  it("deletes a subscription by endpoint", async () => {
    const seeded = await seedUser();
    const db = drizzle(env.REGISTRY_DB, { schema });
    await db.insert(schema.pushSubscriptions).values({
      id: "sub_1",
      userId: seeded.userId,
      endpoint: "https://push.example/sub",
      p256dh: "key",
      auth: "auth",
      userAgent: "Vitest",
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
    });

    const res = await SELF.fetch("https://nadi.test/api/notifications/browser/subscriptions", {
      method: "DELETE",
      headers: {
        ...cookie(seeded.token),
        "content-type": "application/json",
      },
      body: JSON.stringify({ endpoint: "https://push.example/sub" }),
    });

    expect(res.status).toBe(204);
    await expect(
      db
        .select()
        .from(schema.pushSubscriptions)
        .where(eq(schema.pushSubscriptions.endpoint, "https://push.example/sub")),
    ).resolves.toEqual([]);
  });
});
