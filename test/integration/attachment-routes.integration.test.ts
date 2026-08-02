import { SELF, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../src/db/schema";
import { applyRegistryTestSchema } from "./helpers/registry";

const now = 1_800_000_000_000;

async function clearRegistry() {
  const db = drizzle(env.REGISTRY_DB, { schema });
  await db.delete(schema.attachments);
  await db.delete(schema.threadIndex);
  await db.delete(schema.agents);
  await db.delete(schema.workspaceMembers);
  await db.delete(schema.workspaces);
  await db.delete(schema.sessions);
  await db.delete(schema.users);
}

async function seedUserWorkspace(input?: {
  userId?: string;
  token?: string;
  workspaceId?: string;
}) {
  const db = drizzle(env.REGISTRY_DB, { schema });
  const userId = input?.userId ?? "user-attach";
  const token = input?.token ?? "attach-token";
  const workspaceId = input?.workspaceId ?? "ws-up";
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
    createdAt: now,
  });

  return { userId, token, workspaceId, agentId };
}

async function insertThread(input: { id: string; workspaceId: string; agentId: string }) {
  const db = drizzle(env.REGISTRY_DB, { schema });
  await db.insert(schema.threadIndex).values({
    id: input.id,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    title: "Attachments thread",
    source: "manual",
    automatonId: null,
    automatonRunId: null,
    lastEventId: null,
    lastMessagePreview: "",
    createdAt: now,
    updatedAt: now,
  });
}

async function seedThread(threadId = "th-up") {
  const seeded = await seedUserWorkspace();
  await insertThread({ id: threadId, workspaceId: seeded.workspaceId, agentId: seeded.agentId });
  return seeded;
}

function uploadUrl(threadId = "th-up") {
  return `https://nadi.test/api/threads/${threadId}/attachments`;
}

describe("attachment routes", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  beforeEach(async () => {
    await clearRegistry();
  });

  it("rejects unauthenticated upload with 401", async () => {
    await seedThread();
    const fd = new FormData();
    fd.set("file", new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" }));
    const res = await SELF.fetch(uploadUrl(), { method: "POST", body: fd });
    expect(res.status).toBe(401);
  });

  it("rejects unsupported mime with 415", async () => {
    const seeded = await seedThread();
    const fd = new FormData();
    fd.set("file", new File([new Uint8Array([1])], "a.exe", { type: "application/x-msdownload" }));
    const res = await SELF.fetch(uploadUrl(), {
      method: "POST",
      body: fd,
      headers: { cookie: `better-auth.session_token=${seeded.token}` },
    });
    expect(res.status).toBe(415);
  });

  it("accepts a text file by extension even when the browser MIME is empty", async () => {
    const seeded = await seedThread();
    const fd = new FormData();
    fd.set("file", new File([new TextEncoder().encode("hello")], "notes.txt", { type: "" }));
    const res = await SELF.fetch(uploadUrl(), {
      method: "POST",
      body: fd,
      headers: { cookie: `better-auth.session_token=${seeded.token}` },
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { id: string; mimeType: string };
    expect(json.mimeType).toBe("text/plain");
    const obj = await env.ATTACHMENTS_BUCKET.get(`${seeded.workspaceId}/th-up/${json.id}.txt`);
    expect(obj).not.toBeNull();
  });

  it("accepts a code file by extension and stores canonical text/plain", async () => {
    const seeded = await seedThread();
    const fd = new FormData();
    fd.set(
      "file",
      new File([new TextEncoder().encode("export const x = 1")], "mod.ts", { type: "video/mp2t" }),
    );
    const res = await SELF.fetch(uploadUrl(), {
      method: "POST",
      body: fd,
      headers: { cookie: `better-auth.session_token=${seeded.token}` },
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { id: string; mimeType: string };
    expect(json.mimeType).toBe("text/plain");
    const obj = await env.ATTACHMENTS_BUCKET.get(`${seeded.workspaceId}/th-up/${json.id}.ts`);
    expect(obj).not.toBeNull();
  });

  it("stores svg as text/plain (not image/svg+xml) to neutralize script execution", async () => {
    const seeded = await seedThread();
    const fd = new FormData();
    fd.set(
      "file",
      new File(
        [new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>")],
        "logo.svg",
        {
          type: "image/svg+xml",
        },
      ),
    );
    const res = await SELF.fetch(uploadUrl(), {
      method: "POST",
      body: fd,
      headers: { cookie: `better-auth.session_token=${seeded.token}` },
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { id: string; mimeType: string };
    expect(json.mimeType).toBe("text/plain");
    const obj = await env.ATTACHMENTS_BUCKET.get(`${seeded.workspaceId}/th-up/${json.id}.svg`);
    expect(obj).not.toBeNull();
  });

  it("persists the original filename", async () => {
    const seeded = await seedThread();
    const fd = new FormData();
    fd.set("file", new File([new TextEncoder().encode("a,b")], "data.csv", { type: "text/csv" }));
    const up = await SELF.fetch(uploadUrl(), {
      method: "POST",
      body: fd,
      headers: { cookie: `better-auth.session_token=${seeded.token}` },
    });
    const { id } = (await up.json()) as { id: string };
    const { drizzle } = await import("drizzle-orm/d1");
    const { eq } = await import("drizzle-orm");
    const db = drizzle(env.REGISTRY_DB, { schema });
    const row = await db
      .select()
      .from(schema.attachments)
      .where(eq(schema.attachments.id, id))
      .get();
    expect(row?.filename).toBe("data.csv");
    expect(row?.mimeType).toBe("text/csv");
  });

  it("still rejects a disallowed extension with 415", async () => {
    const seeded = await seedThread();
    const fd = new FormData();
    fd.set("file", new File([new Uint8Array([1])], "a.exe", { type: "" }));
    const res = await SELF.fetch(uploadUrl(), {
      method: "POST",
      body: fd,
      headers: { cookie: `better-auth.session_token=${seeded.token}` },
    });
    expect(res.status).toBe(415);
  });

  it("rejects an oversized file with 413", async () => {
    const seeded = await seedThread();
    const tooBig = new Uint8Array(10 * 1024 * 1024 + 1);
    const fd = new FormData();
    fd.set("file", new File([tooBig], "big.png", { type: "image/png" }));
    const res = await SELF.fetch(uploadUrl(), {
      method: "POST",
      body: fd,
      headers: { cookie: `better-auth.session_token=${seeded.token}` },
    });
    expect(res.status).toBe(413);
  });

  it("uploads a png, stores it in R2, and returns metadata", async () => {
    const seeded = await seedThread();
    const fd = new FormData();
    fd.set("file", new File([new Uint8Array([1, 2, 3, 4])], "a.png", { type: "image/png" }));
    fd.set("width", "800");
    fd.set("height", "600");
    const res = await SELF.fetch(uploadUrl(), {
      method: "POST",
      body: fd,
      headers: { cookie: `better-auth.session_token=${seeded.token}` },
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      id: string;
      url: string;
      mimeType: string;
      width: number;
      height: number;
      byteSize: number;
    };
    expect(json.mimeType).toBe("image/png");
    expect(json.url).toBe(`/api/attachments/${json.id}`);
    expect(json.width).toBe(800);
    expect(json.height).toBe(600);
    expect(json.byteSize).toBe(4);

    const obj = await env.ATTACHMENTS_BUCKET.get(`${seeded.workspaceId}/th-up/${json.id}.png`);
    expect(obj).not.toBeNull();
  });

  it("returns 404 uploading to a thread the user is not a member of", async () => {
    const seeded = await seedThread();
    await seedUserWorkspace({
      userId: "other-user",
      token: "other-token",
      workspaceId: "ws-other",
    });
    void seeded;
    const fd = new FormData();
    fd.set("file", new File([new Uint8Array([1])], "a.png", { type: "image/png" }));
    const res = await SELF.fetch(uploadUrl(), {
      method: "POST",
      body: fd,
      headers: { cookie: `better-auth.session_token=other-token` },
    });
    expect(res.status).toBe(404);
  });

  it("serves an uploaded attachment as a 302 to a presigned URL", async () => {
    const seeded = await seedThread();
    const fd = new FormData();
    fd.set("file", new File([new Uint8Array([9])], "b.png", { type: "image/png" }));
    const up = await SELF.fetch(uploadUrl(), {
      method: "POST",
      body: fd,
      headers: { cookie: `better-auth.session_token=${seeded.token}` },
    });
    const { id } = (await up.json()) as { id: string };

    const serveRes = await SELF.fetch(`https://nadi.test/api/attachments/${id}`, {
      headers: { cookie: `better-auth.session_token=${seeded.token}` },
      redirect: "manual",
    });
    expect(serveRes.status).toBe(302);
    expect(serveRes.headers.get("location")).toContain("r2.cloudflarestorage.com");
  });

  it("returns 404 serving an unknown attachment id", async () => {
    const seeded = await seedThread();
    const res = await SELF.fetch("https://nadi.test/api/attachments/does-not-exist", {
      headers: { cookie: `better-auth.session_token=${seeded.token}` },
      redirect: "manual",
    });
    expect(res.status).toBe(404);
  });

  it("returns 401 serving an attachment without a session cookie", async () => {
    const seeded = await seedThread();
    const fd = new FormData();
    fd.set("file", new File([new Uint8Array([9])], "c.png", { type: "image/png" }));
    const up = await SELF.fetch(uploadUrl(), {
      method: "POST",
      body: fd,
      headers: { cookie: `better-auth.session_token=${seeded.token}` },
    });
    const { id } = (await up.json()) as { id: string };

    const res = await SELF.fetch(`https://nadi.test/api/attachments/${id}`, {
      redirect: "manual",
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 serving an attachment when the user is not a workspace member", async () => {
    const seeded = await seedThread();
    const fd = new FormData();
    fd.set("file", new File([new Uint8Array([9])], "d.png", { type: "image/png" }));
    const up = await SELF.fetch(uploadUrl(), {
      method: "POST",
      body: fd,
      headers: { cookie: `better-auth.session_token=${seeded.token}` },
    });
    const { id } = (await up.json()) as { id: string };

    const other = await seedUserWorkspace({
      userId: "user-nonmember",
      token: "token-nonmember",
      workspaceId: "ws-nonmember",
    });

    const res = await SELF.fetch(`https://nadi.test/api/attachments/${id}`, {
      headers: { cookie: `better-auth.session_token=${other.token}` },
      redirect: "manual",
    });
    expect(res.status).toBe(404);
  });
});
