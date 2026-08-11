import { SELF, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../src/db/schema";
import { applyRegistryTestSchema } from "./helpers/registry";
import { attachmentsBucket, backupBucket } from "../../src/storage/bucket-binding";
import { S3Bucket } from "../../src/storage/s3-bucket";
import { FAKE_S3_ENDPOINT, FakeS3 } from "../helpers/fake-s3";

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
  const userId = input?.userId ?? "user-s3";
  const token = input?.token ?? "s3-token";
  const workspaceId = input?.workspaceId ?? "ws-s3";
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

async function seedThread(threadId = "th-s3") {
  const seeded = await seedUserWorkspace();
  const db = drizzle(env.REGISTRY_DB, { schema });
  await db.insert(schema.threadIndex).values({
    id: threadId,
    workspaceId: seeded.workspaceId,
    agentId: seeded.agentId,
    title: "S3 attachments thread",
    source: "manual",
    automatonId: null,
    automatonRunId: null,
    lastEventId: null,
    lastMessagePreview: "",
    createdAt: now,
    updatedAt: now,
  });
  return seeded;
}

describe("celld S3 bucket bindings", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  beforeEach(async () => {
    await clearRegistry();
  });

  it("keeps handing out the real R2 binding on Cloudflare", () => {
    expect(attachmentsBucket(env)).toBe(env.ATTACHMENTS_BUCKET);
    // The pool env has no BACKUP_BUCKET binding; a present binding passes through.
    const fake = {} as R2Bucket;
    expect(backupBucket({ BACKUP_BUCKET: fake })).toBe(fake);
  });

  it("hands out an S3Bucket facade on a celld env with complete S3 config", () => {
    const { ATTACHMENTS_BUCKET: _attachments, ...celldAttachments } = env;
    const celldWithS3 = {
      ...celldAttachments,
      S3_ENDPOINT: FAKE_S3_ENDPOINT,
      S3_ACCESS_KEY_ID: "akid",
      S3_SECRET_ACCESS_KEY: "secret",
      S3_ATTACHMENTS_BUCKET_NAME: "nadi-attachments",
    };
    expect(attachmentsBucket(celldWithS3 as never)).toBeInstanceOf(S3Bucket);
    expect(
      backupBucket({ ...celldWithS3, S3_BACKUP_BUCKET_NAME: "nadi-backups" } as never),
    ).toBeInstanceOf(S3Bucket);
  });

  it("fails loudly on a celld env with no S3 config at all", () => {
    expect(() => attachmentsBucket({} as never)).toThrow(/ATTACHMENTS_BUCKET/);
    expect(() => backupBucket({} as never)).toThrow(/BACKUP_BUCKET/);
  });
});

describe("attachment path end to end against the S3 facade", () => {
  const server = new FakeS3();
  let originalBucket: unknown;

  function plantS3Bucket() {
    const bucket = new S3Bucket({
      endpoint: FAKE_S3_ENDPOINT,
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "SECRETEXAMPLE",
      bucketName: "nadi-attachments",
      fetchImpl: server.handle,
    });
    originalBucket = env.ATTACHMENTS_BUCKET;
    (env as { ATTACHMENTS_BUCKET: unknown }).ATTACHMENTS_BUCKET = bucket;
  }

  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  beforeEach(async () => {
    server.resetObjects();
    await clearRegistry();
  });

  afterEach(() => {
    // Restore the real R2 binding so the other files sharing this isolate
    // (integration-fast runs with fileParallelism: false) see it unchanged.
    (env as { ATTACHMENTS_BUCKET: unknown }).ATTACHMENTS_BUCKET = originalBucket;
    originalBucket = undefined;
  });

  it("uploads through attachment-routes, reads back, serves and deletes via the facade", async () => {
    plantS3Bucket();
    const seeded = await seedThread();
    const content = new TextEncoder().encode("celld attachment bytes");
    const fd = new FormData();
    fd.set("file", new File([content], "note.txt", { type: "text/plain" }));

    const uploadRes = await SELF.fetch(`https://nadi.test/api/threads/th-s3/attachments`, {
      method: "POST",
      body: fd,
      headers: { cookie: `better-auth.session_token=${seeded.token}` },
    });
    expect(uploadRes.status).toBe(201);
    const { id } = (await uploadRes.json()) as { id: string };

    // The upload route stores the object under an r2Key it generates; read it back
    // from the registry to address the same object.
    const db = drizzle(env.REGISTRY_DB, { schema });
    const row = await db
      .select({ r2Key: schema.attachments.r2Key })
      .from(schema.attachments)
      .where(eq(schema.attachments.id, id))
      .get();
    const r2Key = row?.r2Key;
    expect(r2Key).toBeDefined();

    // Bytes landed in the S3-shaped store, not R2: read back through the facade.
    const stored = await env.ATTACHMENTS_BUCKET.get(r2Key!);
    expect(stored).not.toBeNull();
    expect(await stored?.text()).toBe("celld attachment bytes");
    expect(stored?.httpMetadata?.contentType).toBe("text/plain");
    expect(server.objects.get(r2Key!)).toBeDefined();

    // Serve route presigns a URL for the same key.
    const serveRes = await SELF.fetch(`https://nadi.test/api/attachments/${id}`, {
      headers: { cookie: `better-auth.session_token=${seeded.token}` },
      redirect: "manual",
    });
    expect(serveRes.status).toBe(302);
    expect(serveRes.headers.get("location")).toContain(r2Key!);

    // Delete through the facade: the store is now empty for that key.
    await env.ATTACHMENTS_BUCKET.delete(r2Key!);
    expect(await env.ATTACHMENTS_BUCKET.get(r2Key!)).toBeNull();
  });
});
