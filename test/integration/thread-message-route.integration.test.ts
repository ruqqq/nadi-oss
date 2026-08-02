import { SELF, env } from "cloudflare:test";
import { getAgentByName } from "agents";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../../src/db/schema";
import { applyRegistryTestSchema, seedRegistryThread } from "./helpers/registry";

const now = 1_800_000_000_000;

function db() {
  return drizzle(env.REGISTRY_DB, { schema });
}

async function insertUserSession(userId: string, token: string) {
  await db()
    .insert(schema.users)
    .values({
      id: userId,
      email: `${userId}@example.com`,
      name: null,
      createdAt: new Date(now),
      emailVerified: true,
      image: null,
      updatedAt: new Date(now),
    });
  await db()
    .insert(schema.sessions)
    .values({
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

async function insertMembership(userId: string, workspaceId: string) {
  await db().insert(schema.workspaceMembers).values({
    workspaceId,
    userId,
    role: "owner",
    createdAt: now,
  });
}

function post(threadId: string, token: string, message: unknown) {
  return SELF.fetch(`https://example.com/api/threads/${threadId}/messages`, {
    method: "POST",
    headers: {
      cookie: `better-auth.session_token=${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ message }),
  });
}

describe("POST /api/threads/:id/messages", () => {
  beforeEach(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  it("delivers the message into the thread with no client attached", async () => {
    await seedRegistryThread(env.REGISTRY_DB, {
      threadId: "thr_send",
      workspaceId: "ws_send",
      runtime: "think",
    });
    await insertUserSession("user_send", "token_send");
    await insertMembership("user_send", "ws_send");

    const res = await post("thr_send", "token_send", {
      id: "msg_1",
      role: "user",
      parts: [{ type: "text", text: "hello" }],
    });

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({ ok: true });

    // No websocket client ever connected, yet the DO holds the message.
    const stub = (await getAgentByName(env.THINK_THREAD_AGENT, "thr_send")) as unknown as {
      exportHistory(): Promise<unknown[]>;
    };
    expect(JSON.stringify(await stub.exportHistory())).toContain("hello");
  });

  it("404s for a thread the caller is not a member of", async () => {
    await seedRegistryThread(env.REGISTRY_DB, {
      threadId: "thr_other",
      workspaceId: "ws_other",
      runtime: "think",
    });
    await insertUserSession("user_outsider", "token_outsider");

    const res = await post("thr_other", "token_outsider", {
      id: "msg_1",
      role: "user",
      parts: [{ type: "text", text: "hi" }],
    });

    expect(res.status).toBe(404);
  });

  it("rejects an empty message", async () => {
    await seedRegistryThread(env.REGISTRY_DB, {
      threadId: "thr_empty",
      workspaceId: "ws_empty",
      runtime: "think",
    });
    await insertUserSession("user_empty", "token_empty");
    await insertMembership("user_empty", "ws_empty");

    const res = await post("thr_empty", "token_empty", {
      id: "msg_1",
      role: "user",
      parts: [{ type: "text", text: "   " }],
    });

    expect(res.status).toBe(400);
  });

  it("400s for a non-Think thread", async () => {
    await seedRegistryThread(env.REGISTRY_DB, {
      threadId: "thr_legacy",
      workspaceId: "ws_legacy",
      runtime: "legacy",
    });
    await insertUserSession("user_legacy", "token_legacy");
    await insertMembership("user_legacy", "ws_legacy");

    const res = await post("thr_legacy", "token_legacy", {
      id: "msg_1",
      role: "user",
      parts: [{ type: "text", text: "hello" }],
    });

    expect(res.status).toBe(400);
  });

  it("409s for an archived thread", async () => {
    await seedRegistryThread(env.REGISTRY_DB, {
      threadId: "thr_archived",
      workspaceId: "ws_archived",
      runtime: "think",
      archivedAt: now,
    });
    await insertUserSession("user_archived", "token_archived");
    await insertMembership("user_archived", "ws_archived");

    const res = await post("thr_archived", "token_archived", {
      id: "msg_1",
      role: "user",
      parts: [{ type: "text", text: "hello" }],
    });

    expect(res.status).toBe(409);
  });

  it("401s for an unauthenticated request", async () => {
    await seedRegistryThread(env.REGISTRY_DB, {
      threadId: "thr_unauth",
      workspaceId: "ws_unauth",
      runtime: "think",
    });

    const res = await post("thr_unauth", "not_a_real_token", {
      id: "msg_1",
      role: "user",
      parts: [{ type: "text", text: "hello" }],
    });

    expect(res.status).toBe(401);
  });
});

// Regression coverage for a raw `namespace.get(idFromName(...))` stub bypassing
// onStart(): compactThread()/getCompactionStatus() read `this.session`, which
// onStart() (via configureSession) assigns. A thread whose DO has never been
// touched by a client or another route call is genuinely cold here — nothing in
// this test warms it first — so this reproduces the exact condition that threw
// "Cannot read properties of undefined (reading 'compact')" in production.
describe("POST /api/threads/:id/compact on a cold DO", () => {
  beforeEach(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  it("compacts a never-touched Think thread instead of 500ing", async () => {
    await seedRegistryThread(env.REGISTRY_DB, {
      threadId: "thr_cold_compact",
      workspaceId: "ws_cold_compact",
      runtime: "think",
    });
    await insertUserSession("user_cold_compact", "token_cold_compact");
    await insertMembership("user_cold_compact", "ws_cold_compact");

    const res = await SELF.fetch("https://example.com/api/threads/thr_cold_compact/compact", {
      method: "POST",
      headers: { cookie: `better-auth.session_token=token_cold_compact` },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      compacted: false,
      message: "Nothing to compact yet.",
    });
  });

  it("reads compaction status on a never-touched Think thread instead of 500ing", async () => {
    await seedRegistryThread(env.REGISTRY_DB, {
      threadId: "thr_cold_status",
      workspaceId: "ws_cold_status",
      runtime: "think",
    });
    await insertUserSession("user_cold_status", "token_cold_status");
    await insertMembership("user_cold_status", "ws_cold_status");

    const res = await SELF.fetch("https://example.com/api/threads/thr_cold_status/compact/status", {
      headers: { cookie: `better-auth.session_token=token_cold_status` },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ phase: "idle" });
  });
});
