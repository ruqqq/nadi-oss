import { SELF, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { applyRegistryTestSchema } from "./helpers/registry";
import { DEFAULT_THREAD_PAGE } from "../../src/http/thread-routes";

const now = 1_800_000_000_000;
const featureEnv = env as typeof env & {
  BACKGROUND_WORK_ENABLED?: string | undefined;
  NADI_PLATFORM?: string | undefined;
};

function cookie(token: string) {
  return { cookie: `better-auth.session_token=${token}` };
}

async function clearRegistry() {
  const db = drizzle(env.REGISTRY_DB, { schema });
  await db.delete(schema.projects);
  await db.delete(schema.threadIndex);
  await db.delete(schema.agents);
  await db.delete(schema.workspaceMembers);
  await db.delete(schema.workspaces);
  await db.delete(schema.sessions);
  await db.delete(schema.users);
}

async function seedOwner(input?: { token?: string; withThread?: boolean }) {
  const db = drizzle(env.REGISTRY_DB, { schema });
  const userId = "user-bootstrap";
  const token = input?.token ?? "bootstrap-token";
  const workspaceId = "workspace-bootstrap";

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
  await db.insert(schema.workspaces).values({ id: workspaceId, name: "Bootstrap", createdAt: now });
  await db.insert(schema.workspaceMembers).values({
    workspaceId,
    userId,
    role: "owner",
    createdAt: now,
  });
  await db.insert(schema.agents).values({
    id: "agent-default",
    workspaceId,
    name: "Default",
    systemPrompt: "You are Nadi.",
    provider: "mock",
    model: "mock",
    modelInputModalities: JSON.stringify(["text"]),
    createdAt: now,
  });

  if (input?.withThread) {
    await db.insert(schema.threadIndex).values({
      id: "thr-bootstrap-1",
      workspaceId,
      agentId: "agent-default",
      modelProvider: "mock",
      model: "mock",
      modelInputModalities: JSON.stringify(["text"]),
      title: "First thread",
      runtime: "legacy",
      source: "manual",
      automatonId: null,
      automatonRunId: null,
      lastEventId: null,
      lastMessagePreview: "hi",
      createdAt: now,
      updatedAt: now,
    });
  }

  await db.insert(schema.projects).values([
    {
      id: "proj-bootstrap-active",
      workspaceId,
      name: "Active project",
      description: "",
      customInstructions: "",
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "proj-bootstrap-archived",
      workspaceId,
      name: "Archived project",
      description: "",
      customInstructions: "",
      archivedAt: now + 1,
      createdAt: now,
      updatedAt: now,
    },
  ]);

  return { userId, token, workspaceId };
}

describe("bootstrap route", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  beforeEach(async () => {
    await clearRegistry();
  });

  afterEach(async () => {
    await clearRegistry();
  });

  it("returns an unauthenticated session and no settings/threads without a cookie", async () => {
    const res = await SELF.fetch("https://nadi.test/api/bootstrap");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { session: { authenticated: boolean }; settings?: unknown };
    expect(body.session).toEqual({ authenticated: false });
    expect(body.settings).toBeUndefined();
  });

  it("returns session, default settings, threads, and active projects in one response for an owner", async () => {
    const { userId, token } = await seedOwner({ withThread: true });

    const res = await SELF.fetch("https://nadi.test/api/bootstrap", { headers: cookie(token) });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      session: { authenticated: boolean; user: { id: string; email: string } };
      settings: { workspace: { id: string }; agent: { model: string }; providers: unknown[] };
      threads: Array<{ threadId: string; title: string }>;
      projects: Array<{ id: string; name: string; archivedAt: number | null }>;
      agents: Array<{ id: string; name: string }>;
    };

    expect(body.session).toEqual({
      authenticated: true,
      user: { id: userId, email: `${userId}@example.com` },
    });
    expect(body.settings.workspace.id).toBe("workspace-bootstrap");
    expect(body.settings.agent.model).toBe("mock");
    expect(Array.isArray(body.settings.providers)).toBe(true);
    expect(body.threads).toHaveLength(1);
    expect(body.threads[0]).toMatchObject({ threadId: "thr-bootstrap-1", title: "First thread" });
    expect(body.projects).toEqual([
      expect.objectContaining({
        id: "proj-bootstrap-active",
        name: "Active project",
        archivedAt: null,
      }),
    ]);
    // Task 5: bootstrap gains the workspace's agent list, for the client's
    // agent pickers — no separate `GET /api/agents` round trip on first paint.
    expect(body.agents).toEqual([
      expect.objectContaining({ id: "agent-default", name: "Default" }),
    ]);
  });

  it("caps the bootstrap thread list at DEFAULT_THREAD_PAGE and returns a cursor for the rest", async () => {
    // Phase-2 cap, shipped together with: BOOTSTRAP_CACHE_VERSION bumped to 2
    // (so a pre-cap cache is never rehydrated as if it were this shape) and
    // the client seeding threadsNextCursor from this response (so the "Older
    // chats" affordance is honest at cold launch, including offline). All
    // three ship in the same change — this test only proves the server half.
    const { token, workspaceId } = await seedOwner();
    const db = drizzle(env.REGISTRY_DB, { schema });
    for (let i = 0; i < DEFAULT_THREAD_PAGE + 5; i++) {
      await db.insert(schema.threadIndex).values({
        id: `thr-bootstrap-many-${i}`,
        workspaceId,
        agentId: "agent-default",
        modelProvider: "mock",
        model: "mock",
        modelInputModalities: JSON.stringify(["text"]),
        title: `Chat ${i}`,
        runtime: "legacy",
        source: "manual",
        automatonId: null,
        automatonRunId: null,
        lastEventId: null,
        lastMessagePreview: "hi",
        createdAt: now - i,
        updatedAt: now - i,
      });
    }

    const res = await SELF.fetch("https://nadi.test/api/bootstrap", { headers: cookie(token) });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { threads: unknown[]; threadsNextCursor: unknown };
    expect(body.threads).toHaveLength(DEFAULT_THREAD_PAGE);
    expect(typeof body.threadsNextCursor).toBe("string");
    expect((body.threadsNextCursor as string).length).toBeGreaterThan(0);
  });

  it("reports voiceInput off when the flag is unset", async () => {
    const { token } = await seedOwner();
    const previous = env.VOICE_INPUT_ENABLED;
    env.VOICE_INPUT_ENABLED = "";

    try {
      const res = await SELF.fetch("https://nadi.test/api/bootstrap", { headers: cookie(token) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { features: { voiceInput: boolean } };
      expect(body.features.voiceInput).toBe(false);
    } finally {
      env.VOICE_INPUT_ENABLED = previous;
    }
  });

  it("reports voiceInput on when the flag is set", async () => {
    const { token } = await seedOwner();
    const previous = env.VOICE_INPUT_ENABLED;
    env.VOICE_INPUT_ENABLED = "true";

    try {
      const res = await SELF.fetch("https://nadi.test/api/bootstrap", { headers: cookie(token) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { features: { voiceInput: boolean } };
      expect(body.features.voiceInput).toBe(true);
    } finally {
      env.VOICE_INPUT_ENABLED = previous;
    }
  });

  it("reports voiceInput off on celld even when the flag is set", async () => {
    // celld has no AI binding: the flag can only turn voice OFF, never on, and
    // bootstrap must agree with VoiceAgent's runtime refusal.
    const { token } = await seedOwner();
    const previousPlatform = featureEnv.NADI_PLATFORM;
    const previousFlag = env.VOICE_INPUT_ENABLED;
    featureEnv.NADI_PLATFORM = "celld";
    env.VOICE_INPUT_ENABLED = "true";

    try {
      const res = await SELF.fetch("https://nadi.test/api/bootstrap", { headers: cookie(token) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { features: { voiceInput: boolean } };
      expect(body.features.voiceInput).toBe(false);
    } finally {
      featureEnv.NADI_PLATFORM = previousPlatform;
      env.VOICE_INPUT_ENABLED = previousFlag;
    }
  });

  it("reports agentNetworkAllowlist off when the workspace flag is unset", async () => {
    const { token } = await seedOwner();

    const res = await SELF.fetch("https://nadi.test/api/bootstrap", { headers: cookie(token) });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      features: { agentNetworkAllowlist: boolean };
    };
    expect(body.features.agentNetworkAllowlist).toBe(false);
  });

  it("reports agentNetworkAllowlist on when the workspace flag is set", async () => {
    const { token, workspaceId } = await seedOwner();
    const db = drizzle(env.REGISTRY_DB, { schema });
    await db
      .update(schema.workspaces)
      .set({ flagsJson: JSON.stringify({ agentNetworkAllowlist: true }) })
      .where(eq(schema.workspaces.id, workspaceId));

    const res = await SELF.fetch("https://nadi.test/api/bootstrap", { headers: cookie(token) });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      features: { agentNetworkAllowlist: boolean };
    };
    expect(body.features.agentNetworkAllowlist).toBe(true);
  });

  it("reports the authenticated workspace backgroundWork override when deployment is off", async () => {
    const { token } = await seedOwner();
    const previous = featureEnv.BACKGROUND_WORK_ENABLED;
    featureEnv.BACKGROUND_WORK_ENABLED = "";
    const db = drizzle(env.REGISTRY_DB, { schema });
    await db
      .update(schema.workspaces)
      .set({ flagsJson: JSON.stringify({ backgroundWork: true }) })
      .where(eq(schema.workspaces.id, "workspace-bootstrap"));

    try {
      const res = await SELF.fetch("https://nadi.test/api/bootstrap", { headers: cookie(token) });
      const body = (await res.json()) as { features: { backgroundWork?: boolean } };
      expect(body.features.backgroundWork).toBe(true);
    } finally {
      featureEnv.BACKGROUND_WORK_ENABLED = previous;
    }
  });

  it("reports the authenticated workspace backgroundWork override when deployment is on", async () => {
    const { token } = await seedOwner();
    const previous = featureEnv.BACKGROUND_WORK_ENABLED;
    featureEnv.BACKGROUND_WORK_ENABLED = "yes";
    const db = drizzle(env.REGISTRY_DB, { schema });
    await db
      .update(schema.workspaces)
      .set({ flagsJson: JSON.stringify({ backgroundWork: false }) })
      .where(eq(schema.workspaces.id, "workspace-bootstrap"));

    try {
      const res = await SELF.fetch("https://nadi.test/api/bootstrap", { headers: cookie(token) });
      const body = (await res.json()) as { features: { backgroundWork?: boolean } };
      expect(body.features.backgroundWork).toBe(false);
    } finally {
      featureEnv.BACKGROUND_WORK_ENABLED = previous;
    }
  });

  it("returns null settings (not a 404) when the signed-in user owns no workspace", async () => {
    // Seed a user + session but no workspace membership.
    const db = drizzle(env.REGISTRY_DB, { schema });
    await db.insert(schema.users).values({
      id: "user-orphan",
      email: "orphan@example.com",
      name: null,
      createdAt: new Date(now),
      emailVerified: true,
      image: null,
      updatedAt: new Date(now),
    });
    await db.insert(schema.sessions).values({
      id: "session-orphan",
      userId: "user-orphan",
      token: "orphan-token",
      expiresAt: new Date(now + 60_000),
      createdAt: new Date(now),
      updatedAt: new Date(now),
      ipAddress: null,
      userAgent: null,
    });

    const res = await SELF.fetch("https://nadi.test/api/bootstrap", {
      headers: cookie("orphan-token"),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      session: { authenticated: boolean };
      settings: unknown;
      threads: unknown[];
      projects: unknown[];
    };
    expect(body.session).toMatchObject({ authenticated: true });
    expect(body.settings).toBeNull();
    expect(body.threads).toEqual([]);
    expect(body.projects).toEqual([]);
  });
});
