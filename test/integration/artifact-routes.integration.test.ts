import { SELF, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../src/db/schema";
import { ArtifactRepository } from "../../src/db/artifact-repository";
import { applyRegistryTestSchema } from "./helpers/registry";

type EnvWithArtifactsHost = typeof env & { ARTIFACTS_HOST?: string };

const now = 1_800_000_000_000;

function cookie(token: string) {
  return { cookie: `better-auth.session_token=${token}` };
}

async function clearArtifactsAndThreads() {
  const db = drizzle(env.REGISTRY_DB, { schema });
  await db.delete(schema.artifacts);
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
    await env.ATTACHMENTS_BUCKET.put(`${seeded.workspaceId}/${seeded.threadId}/${seeded.artifactId}/index.html`, "html");

    const res = await SELF.fetch(`https://nadi.test/api/artifacts/${seeded.artifactId}`, {
      headers: cookie(seeded.token),
    });
    expect(res.status).toBe(410);

    const row = await new ArtifactRepository(env.REGISTRY_DB).getById(seeded.artifactId);
    expect(row?.status).toBe("expired");
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
});
