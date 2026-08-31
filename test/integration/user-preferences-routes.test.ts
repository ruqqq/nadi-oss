import { SELF, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../src/db/schema";
import { applyRegistryTestSchema } from "./helpers/registry";

const now = 1_800_000_000_000;

async function seedUser(userId: string, token: string) {
  const db = drizzle(env.REGISTRY_DB, { schema });
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
}

function authed(token: string, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      cookie: `better-auth.session_token=${token}`,
    },
  };
}

describe("user preferences routes", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  // The workers-pool test harness gives every `it()` its own isolated storage
  // snapshot taken as of the start of the test; writes made in `beforeAll` do
  // not carry into that snapshot (only the schema DDL applied via
  // applyRegistryTestSchema does). voice-routing.integration.test.ts and
  // notification-routes.integration.test.ts both seed per-test rather than
  // once in `beforeAll` for the same reason. Seed the user again before every
  // test so the session actually exists when the request is made.
  beforeEach(async () => {
    await seedUser("pref-user", "pref-token");
  });

  it("rejects an unauthenticated read", async () => {
    const res = await SELF.fetch("https://nadi.test/api/settings/preferences");
    expect(res.status).toBe(401);
  });

  it("defaults showReasoning to true when the user has no row", async () => {
    const res = await SELF.fetch(
      "https://nadi.test/api/settings/preferences",
      authed("pref-token"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ showReasoning: true });
  });

  it("saves and reads back a preference", async () => {
    const put = await SELF.fetch(
      "https://nadi.test/api/settings/preferences",
      authed("pref-token", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ showReasoning: false }),
      }),
    );
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ showReasoning: false });

    const get = await SELF.fetch(
      "https://nadi.test/api/settings/preferences",
      authed("pref-token"),
    );
    expect(await get.json()).toEqual({ showReasoning: false });
  });

  it("rejects a non-boolean value", async () => {
    const res = await SELF.fetch(
      "https://nadi.test/api/settings/preferences",
      authed("pref-token", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ showReasoning: "yes" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects an unsupported method", async () => {
    const res = await SELF.fetch(
      "https://nadi.test/api/settings/preferences",
      authed("pref-token", { method: "DELETE" }),
    );
    expect(res.status).toBe(405);
  });
});
