import { SELF, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../src/db/schema";
import { ArtifactRepository } from "../../src/db/artifact-repository";
import { AttachmentRepository } from "../../src/db/attachment-repository";
import { applyRegistryTestSchema } from "./helpers/registry";

type EnvWithArtifactsHost = typeof env & { ARTIFACTS_HOST?: string };

const now = 1_800_000_000_000;

function cookie(token: string) {
  return { cookie: `better-auth.session_token=${token}` };
}

async function clearArtifactsAndThreads() {
  const db = drizzle(env.REGISTRY_DB, { schema });
  await db.delete(schema.artifacts);
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
  const userId = input?.userId ?? "user-art";
  const token = input?.token ?? "art-token";
  const workspaceId = input?.workspaceId ?? "ws-art";
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
    title: "Artifact thread",
    source: "manual",
    automatonId: null,
    automatonRunId: null,
    lastEventId: null,
    lastMessagePreview: "",
    createdAt: now,
    updatedAt: now,
  });
}

async function seedArtifact(input?: {
  id?: string;
  threadId?: string;
  workspaceId?: string;
  expiresAt?: number;
}) {
  const seeded = await seedUserWorkspace();
  const threadId = input?.threadId ?? "th-art";
  await insertThread({ id: threadId, workspaceId: seeded.workspaceId, agentId: seeded.agentId });

  const id = input?.id ?? "art_test1";
  await new ArtifactRepository(env.REGISTRY_DB).insert({
    id,
    workspaceId: input?.workspaceId ?? seeded.workspaceId,
    threadId,
    title: "Dashboard",
    entryPath: "index.html",
    fileCount: 2,
    byteSize: 1024,
    r2Prefix: `${seeded.workspaceId}/${threadId}/${id}/`,
    status: "active",
    expiresAt: input?.expiresAt ?? now + 86_400_000,
    createdAt: now,
  });

  return { ...seeded, threadId, artifactId: id };
}

describe("artifact routes", () => {
  let previousArtifactsHost: string | undefined;

  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  beforeEach(async () => {
    previousArtifactsHost = (env as EnvWithArtifactsHost).ARTIFACTS_HOST;
    (env as EnvWithArtifactsHost).ARTIFACTS_HOST = "artifacts.example.com";
    await clearArtifactsAndThreads();
  });

  afterEach(() => {
    if (previousArtifactsHost === undefined) {
      delete (env as EnvWithArtifactsHost).ARTIFACTS_HOST;
    } else {
      (env as EnvWithArtifactsHost).ARTIFACTS_HOST = previousArtifactsHost;
    }
  });

  it("rejects unauthenticated metadata with 401", async () => {
    await seedArtifact();
    const res = await SELF.fetch("https://nadi.test/api/artifacts/art_test1");
    expect(res.status).toBe(401);
  });

  it("rejects unauthenticated view mint with 401", async () => {
    await seedArtifact();
    const res = await SELF.fetch("https://nadi.test/api/artifacts/art_test1/view", {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 for non-members", async () => {
    const owner = await seedArtifact();
    const outsider = await seedUserWorkspace({
      userId: "user-outsider",
      token: "outsider-token",
      workspaceId: "ws-other",
    });
    await insertThread({
      id: "th-other",
      workspaceId: outsider.workspaceId,
      agentId: outsider.agentId,
    });

    const res = await SELF.fetch(`https://nadi.test/api/artifacts/${owner.artifactId}`, {
      headers: cookie(outsider.token),
    });
    expect(res.status).toBe(404);
  });

  it("returns 410 for expired artifacts on GET", async () => {
    const expiredAt = Date.now() - 60_000;
    const seeded = await seedArtifact({ expiresAt: expiredAt });
    await env.ATTACHMENTS_BUCKET.put(
      `${seeded.workspaceId}/${seeded.threadId}/${seeded.artifactId}/index.html`,
      "html",
    );

    const res = await SELF.fetch(`https://nadi.test/api/artifacts/${seeded.artifactId}`, {
      headers: cookie(seeded.token),
    });
    expect(res.status).toBe(410);

    const row = await new ArtifactRepository(env.REGISTRY_DB).getById(seeded.artifactId);
    expect(row?.status).toBe("expired");
    expect(
      await env.ATTACHMENTS_BUCKET.get(
        `${seeded.workspaceId}/${seeded.threadId}/${seeded.artifactId}/index.html`,
      ),
    ).not.toBeNull();
  });

  it("returns metadata for workspace members", async () => {
    const seeded = await seedArtifact();
    const res = await SELF.fetch(`https://nadi.test/api/artifacts/${seeded.artifactId}`, {
      headers: cookie(seeded.token),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      id: string;
      title: string;
      entryPath: string;
      fileCount: number;
      byteSize: number;
      expiresAt: number;
      status: string;
      url: string;
    };
    expect(json).toMatchObject({
      id: seeded.artifactId,
      title: "Dashboard",
      entryPath: "index.html",
      fileCount: 2,
      byteSize: 1024,
      status: "active",
      url: `/api/artifacts/${seeded.artifactId}`,
    });
    expect(json.expiresAt).toBeGreaterThan(Date.now() - 5_000);
  });

  it("mints a view URL containing token and artifact id", async () => {
    const seeded = await seedArtifact();
    const res = await SELF.fetch(`https://nadi.test/api/artifacts/${seeded.artifactId}/view`, {
      method: "POST",
      headers: cookie(seeded.token),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { viewUrl: string; expiresAt: number };
    expect(json.viewUrl).toContain(`/${seeded.artifactId}/`);
    expect(json.viewUrl).toMatch(/^https:\/\/artifacts\.example\.com\/v\/.+\/art_test1\/$/);
    expect(json.expiresAt).toBeGreaterThan(Date.now() - 5_000);
    expect(json.expiresAt).toBeLessThanOrEqual(Date.now() + 15 * 60 * 1000 + 5_000);
  });

  it("returns 503 when ARTIFACTS_HOST is unset", async () => {
    delete (env as EnvWithArtifactsHost).ARTIFACTS_HOST;
    const seeded = await seedArtifact();
    const res = await SELF.fetch(`https://nadi.test/api/artifacts/${seeded.artifactId}/view`, {
      method: "POST",
      headers: cookie(seeded.token),
    });
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("Artifact preview host is not configured");
  });

  it("rejects unauthenticated republish with 401", async () => {
    await seedArtifact();
    const res = await SELF.fetch("https://nadi.test/api/artifacts/art_test1/republish", {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 when a non-member republishes", async () => {
    const owner = await seedArtifact();
    const outsider = await seedUserWorkspace({
      userId: "user-outsider",
      token: "outsider-token",
      workspaceId: "ws-other",
    });
    const res = await SELF.fetch(`https://nadi.test/api/artifacts/${owner.artifactId}/republish`, {
      method: "POST",
      headers: cookie(outsider.token),
    });
    expect(res.status).toBe(404);
  });

  it("republishes an expired artifact when its files are still in R2", async () => {
    const expiredAt = Date.now() - 60_000;
    const seeded = await seedArtifact({ expiresAt: expiredAt });
    const objectKey = `${seeded.workspaceId}/${seeded.threadId}/${seeded.artifactId}/index.html`;
    await env.ATTACHMENTS_BUCKET.put(objectKey, "html");
    await new ArtifactRepository(env.REGISTRY_DB).markExpired(seeded.artifactId);

    const before = Date.now();
    const res = await SELF.fetch(`https://nadi.test/api/artifacts/${seeded.artifactId}/republish`, {
      method: "POST",
      headers: cookie(seeded.token),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      id: string;
      status: string;
      expiresAt: number;
      url: string;
    };
    expect(json).toMatchObject({
      id: seeded.artifactId,
      status: "active",
      url: `/api/artifacts/${seeded.artifactId}`,
    });
    expect(json.expiresAt).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000 - 5_000);
    expect(json.expiresAt).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60 * 1000 + 5_000);

    const row = await new ArtifactRepository(env.REGISTRY_DB).getById(seeded.artifactId);
    expect(row?.status).toBe("active");
    expect(row?.expiresAt).toBe(json.expiresAt);

    const view = await SELF.fetch(`https://nadi.test/api/artifacts/${seeded.artifactId}/view`, {
      method: "POST",
      headers: cookie(seeded.token),
    });
    expect(view.status).toBe(200);
  });

  it("returns 410 when republishing an artifact whose files are gone", async () => {
    const seeded = await seedArtifact({ id: "art_gone", expiresAt: Date.now() - 60_000 });
    await new ArtifactRepository(env.REGISTRY_DB).markExpired(seeded.artifactId);

    const res = await SELF.fetch(`https://nadi.test/api/artifacts/${seeded.artifactId}/republish`, {
      method: "POST",
      headers: cookie(seeded.token),
    });
    expect(res.status).toBe(410);
    expect(await res.text()).toBe(
      "This artifact's files are gone. Ask the assistant to publish it again.",
    );
  });

  it("lists a thread's artifacts and committed downloads newest first", async () => {
    const seeded = await seedUserWorkspace();
    await insertThread({ id: "th-list", workspaceId: seeded.workspaceId, agentId: seeded.agentId });
    const artifacts = new ArtifactRepository(env.REGISTRY_DB);
    await artifacts.insert({
      id: "art_old",
      workspaceId: seeded.workspaceId,
      threadId: "th-list",
      title: "Old dashboard",
      entryPath: "index.html",
      fileCount: 1,
      byteSize: 10,
      r2Prefix: `${seeded.workspaceId}/th-list/art_old/`,
      status: "active",
      expiresAt: now + 86_400_000,
      createdAt: now - 2_000,
    });
    await artifacts.insert({
      id: "art_new",
      workspaceId: seeded.workspaceId,
      threadId: "th-list",
      title: "New dashboard",
      entryPath: "index.html",
      fileCount: 2,
      byteSize: 20,
      r2Prefix: `${seeded.workspaceId}/th-list/art_new/`,
      status: "active",
      expiresAt: now + 86_400_000,
      createdAt: now - 1_000,
    });
    await artifacts.insert({
      id: "art_other",
      workspaceId: seeded.workspaceId,
      threadId: "th-other",
      title: "Other thread",
      entryPath: "index.html",
      fileCount: 1,
      byteSize: 5,
      r2Prefix: `${seeded.workspaceId}/th-other/art_other/`,
      status: "active",
      expiresAt: now + 86_400_000,
      createdAt: now,
    });

    const attachments = new AttachmentRepository(env.REGISTRY_DB);
    await attachments.insert({
      id: "att_pending",
      workspaceId: seeded.workspaceId,
      threadId: "th-list",
      mimeType: "image/png",
      filename: "pending.png",
      byteSize: 12,
      r2Key: `${seeded.workspaceId}/th-list/att_pending`,
      status: "pending",
      createdAt: now,
    });
    await attachments.insert({
      id: "att_old",
      workspaceId: seeded.workspaceId,
      threadId: "th-list",
      mimeType: "text/plain",
      filename: "notes.txt",
      byteSize: 40,
      r2Key: `${seeded.workspaceId}/th-list/att_old`,
      status: "committed",
      createdAt: now - 3_000,
    });
    await attachments.insert({
      id: "att_new",
      workspaceId: seeded.workspaceId,
      threadId: "th-list",
      mimeType: "image/png",
      filename: "chart.png",
      byteSize: 80,
      r2Key: `${seeded.workspaceId}/th-list/att_new`,
      status: "committed",
      createdAt: now - 500,
    });

    const res = await SELF.fetch("https://nadi.test/api/threads/th-list/artifacts", {
      headers: cookie(seeded.token),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      artifacts: Array<{ id: string; title: string; url: string; createdAt: number }>;
      downloads: Array<{ id: string; filename: string | null; url: string }>;
    };
    expect(json.artifacts.map((row) => row.id)).toEqual(["art_new", "art_old"]);
    expect(json.artifacts[0]).toMatchObject({
      title: "New dashboard",
      url: "/api/artifacts/art_new",
    });
    expect(json.downloads.map((row) => row.id)).toEqual(["att_new", "att_old"]);
    expect(json.downloads[0]).toMatchObject({
      filename: "chart.png",
      url: "/api/attachments/att_new",
    });
  });

  it("returns empty arrays when a member's thread has no artifacts or downloads", async () => {
    const seeded = await seedUserWorkspace();
    await insertThread({
      id: "th-empty",
      workspaceId: seeded.workspaceId,
      agentId: seeded.agentId,
    });
    const res = await SELF.fetch("https://nadi.test/api/threads/th-empty/artifacts", {
      headers: cookie(seeded.token),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ artifacts: [], downloads: [] });
  });

  it("rejects unauthenticated thread artifact lists with 401", async () => {
    const res = await SELF.fetch("https://nadi.test/api/threads/th-list/artifacts");
    expect(res.status).toBe(401);
  });

  it("hides another workspace's thread list behind 404", async () => {
    const owner = await seedUserWorkspace();
    await insertThread({ id: "th-secret", workspaceId: owner.workspaceId, agentId: owner.agentId });
    const outsider = await seedUserWorkspace({
      userId: "user-outsider",
      token: "outsider-token",
      workspaceId: "ws-outsider",
    });
    const res = await SELF.fetch("https://nadi.test/api/threads/th-secret/artifacts", {
      headers: cookie(outsider.token),
    });
    expect(res.status).toBe(404);
  });
});
