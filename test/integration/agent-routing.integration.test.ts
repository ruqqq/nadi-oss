import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { authorizeAgentRequest } from "../../src/agent-routing/authorize";
import { resolveThreadRuntimeConfigForAgent } from "../../src/agent/thread-agent-config";

const now = 1_800_000_000_000;

async function seedRegisteredThread(input?: {
  userId?: string;
  token?: string;
  expiresAt?: number;
  workspaceId?: string;
  threadId?: string;
  membership?: boolean;
  provider?: string;
  model?: string;
  modelInputModalities?: string[];
  threadProvider?: string;
  threadModel?: string;
  threadModelInputModalities?: string[];
  threadShowReasoning?: boolean;
  archivedAt?: number | null;
}) {
  const db = drizzle(env.REGISTRY_DB, { schema });
  const userId = input?.userId ?? "user-1";
  const token = input?.token ?? "live-token";
  const workspaceId = input?.workspaceId ?? "workspace-1";
  const threadId = input?.threadId ?? "thr_registered";
  const createdAt = now;

  await db.insert(schema.users).values({
    id: userId,
    email: `${userId}@example.com`,
    name: null,
    createdAt: new Date(createdAt),
    emailVerified: true,
    image: null,
    updatedAt: new Date(createdAt),
  });
  await db.insert(schema.sessions).values({
    id: `session-${userId}`,
    userId,
    token,
    expiresAt: new Date(input?.expiresAt ?? now + 60_000),
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
    ipAddress: null,
    userAgent: null,
  });
  await db.insert(schema.workspaces).values({
    id: workspaceId,
    name: workspaceId,
    createdAt,
  });
  if (input?.membership ?? true) {
    await db.insert(schema.workspaceMembers).values({
      workspaceId,
      userId,
      role: "owner",
      createdAt,
    });
  }
  await db.insert(schema.agents).values({
    id: `agent-${workspaceId}`,
    workspaceId,
    name: "Default",
    systemPrompt: "You are Nadi.",
    provider: input?.provider ?? "mock",
    model: input?.model ?? "mock",
    modelInputModalities: JSON.stringify(input?.modelInputModalities ?? ["text"]),
    createdAt,
  });
  await db.insert(schema.threadIndex).values({
    id: threadId,
    workspaceId,
    agentId: `agent-${workspaceId}`,
    modelProvider: input?.threadProvider ?? null,
    model: input?.threadModel ?? null,
    modelInputModalities: input?.threadModelInputModalities
      ? JSON.stringify(input.threadModelInputModalities)
      : null,
    title: "Registered",
    source: "manual",
    automatonId: null,
    automatonRunId: null,
    lastEventId: null,
    lastMessagePreview: "",
    archivedAt: input?.archivedAt ?? null,
    createdAt,
    updatedAt: createdAt,
  });

  return { token, threadId, userId, workspaceId };
}

describe("agent routing", () => {
  // The retired runtime's route is no longer a route at all, so it 404s before
  // the session is even looked at. Unauthenticated callers still never reach a DO.
  it("returns 404 for the retired /agents/thread-agent route without a session cookie", async () => {
    const res = await SELF.fetch("https://nadi.test/agents/thread-agent/thr_registered");
    expect(res.status).toBe(404);
  });

  it("returns 401 for /think-agents/* without a session cookie", async () => {
    const res = await SELF.fetch(
      "https://nadi.test/think-agents/think-thread-agent/thr_registered",
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 for a fake session cookie", async () => {
    await seedRegisteredThread();
    const res = await SELF.fetch(
      "https://nadi.test/think-agents/think-thread-agent/thr_registered",
      { headers: { cookie: "better-auth.session_token=fake-token" } },
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 for an expired session", async () => {
    const seeded = await seedRegisteredThread({ token: "expired-token", expiresAt: 1 });
    const res = await SELF.fetch(
      `https://nadi.test/think-agents/think-thread-agent/${seeded.threadId}`,
      {
        headers: { cookie: `better-auth.session_token=${seeded.token}` },
      },
    );
    expect(res.status).toBe(401);
  });

  it("denies a previously valid session after it is revoked", async () => {
    const seeded = await seedRegisteredThread();
    const db = drizzle(env.REGISTRY_DB, { schema });
    const buildReq = () =>
      new Request(`https://nadi.test/think-agents/think-thread-agent/${seeded.threadId}`, {
        headers: { cookie: `better-auth.session_token=${seeded.token}` },
      });

    // The live session authorizes before revocation.
    await expect(authorizeAgentRequest(buildReq(), env)).resolves.toMatchObject({
      authorized: true,
    });

    // Revoke by deleting the session row, as Better Auth does on sign-out/revoke.
    await db.delete(schema.sessions).where(eq(schema.sessions.token, seeded.token));

    const after = await authorizeAgentRequest(buildReq(), env);
    expect(after.authorized).toBe(false);
    if (!after.authorized) expect(after.response.status).toBe(401);
  });

  it("returns 404 for an unknown thread with a valid session", async () => {
    const seeded = await seedRegisteredThread();
    const res = await SELF.fetch("https://nadi.test/think-agents/think-thread-agent/thr_missing", {
      headers: { cookie: `better-auth.session_token=${seeded.token}` },
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 for an unknown Think thread with a valid session", async () => {
    const seeded = await seedRegisteredThread();
    const res = await SELF.fetch("https://nadi.test/think-agents/think-thread-agent/thr_missing", {
      headers: { cookie: `better-auth.session_token=${seeded.token}` },
    });
    expect(res.status).toBe(404);
  });

  it("404s the retired /agents/thread-agent route even for a registered thread", async () => {
    const seeded = await seedRegisteredThread({ threadId: "thr_retired_route" });
    const req = new Request(`https://nadi.test/agents/thread-agent/${seeded.threadId}`, {
      headers: { cookie: `better-auth.session_token=${seeded.token}` },
    });

    const result = await authorizeAgentRequest(req, env);
    expect(result.authorized).toBe(false);
    if (!result.authorized) expect(result.response.status).toBe(404);
  });

  it("returns 404 when the valid session is not a workspace member", async () => {
    const seeded = await seedRegisteredThread({ membership: false });
    const res = await SELF.fetch(
      `https://nadi.test/think-agents/think-thread-agent/${seeded.threadId}`,
      {
        headers: { cookie: `better-auth.session_token=${seeded.token}` },
      },
    );
    expect(res.status).toBe(404);
  });

  it("authorizes a valid session for a registered workspace thread", async () => {
    const seeded = await seedRegisteredThread();
    const req = new Request(
      `https://nadi.test/think-agents/think-thread-agent/${seeded.threadId}`,
      {
        headers: { cookie: `better-auth.session_token=${seeded.token}` },
      },
    );

    await expect(authorizeAgentRequest(req, env)).resolves.toEqual({
      authorized: true,
      threadId: seeded.threadId,
      userId: seeded.userId,
      workspaceId: seeded.workspaceId,
    });
  });

  it("blocks active agent routes for archived threads but allows history hydration", async () => {
    const seeded = await seedRegisteredThread({ archivedAt: now + 1 });

    const websocket = await authorizeAgentRequest(
      new Request(`https://nadi.test/think-agents/think-thread-agent/${seeded.threadId}`, {
        headers: {
          cookie: `better-auth.session_token=${seeded.token}`,
          upgrade: "websocket",
        },
      }),
      env,
    );
    expect(websocket.authorized).toBe(false);
    if (!websocket.authorized) expect(websocket.response.status).toBe(410);

    await expect(
      authorizeAgentRequest(
        new Request(
          `https://nadi.test/think-agents/think-thread-agent/${seeded.threadId}/get-messages`,
          {
            headers: { cookie: `better-auth.session_token=${seeded.token}` },
          },
        ),
        env,
      ),
    ).resolves.toMatchObject({ authorized: true, threadId: seeded.threadId });
  });

  it("uses the registered thread workspace instead of DEFAULT_WORKSPACE_ID", async () => {
    const seeded = await seedRegisteredThread({
      threadId: "thr_workspace_resolution",
      workspaceId: "workspace-thread",
    });

    const config = await resolveThreadRuntimeConfigForAgent(env, seeded.threadId);

    expect(config?.workspaceId).toBe("workspace-thread");
  });

  it("resolves to null when the agent thread has no registry row", async () => {
    expect(await resolveThreadRuntimeConfigForAgent(env, "thr_unregistered")).toBeNull();
  });
});

describe("thread runtime config export", () => {
  it("exports the shared resolver for alternate runtimes", () => {
    expect(typeof resolveThreadRuntimeConfigForAgent).toBe("function");
  });

  it("uses the thread model snapshot after linked agent settings change", async () => {
    const seeded = await seedRegisteredThread({
      workspaceId: "workspace-snapshot",
      threadId: "thr_snapshot_runtime",
      provider: "mock",
      model: "mock",
      modelInputModalities: ["text"],
      threadProvider: "mock-tool-call",
      threadModel: "mock-tool-call",
      threadModelInputModalities: ["text", "image"],
    });

    const db = drizzle(env.REGISTRY_DB, { schema });
    await db
      .update(schema.agents)
      .set({
        provider: "mock",
        model: "mock",
        modelInputModalities: JSON.stringify(["text"]),
      })
      .where(eq(schema.agents.id, `agent-${seeded.workspaceId}`));

    await expect(resolveThreadRuntimeConfigForAgent(env, seeded.threadId)).resolves.toMatchObject({
      workspaceId: seeded.workspaceId,
      agentId: `agent-${seeded.workspaceId}`,
      backgroundExecEnabled: true,
      subagentsEnabled: true,
      modelConfig: {
        provider: "mock-tool-call",
        model: "mock-tool-call",
        modelInputModalities: ["text", "image"],
      },
    });
  });

  it("resolves the workspace background-work override over the deployment default", async () => {
    const seeded = await seedRegisteredThread({
      workspaceId: "workspace-background-work-override",
      threadId: "thr_background_work_override",
      provider: "mock",
      model: "mock",
      modelInputModalities: ["text"],
    });
    const db = drizzle(env.REGISTRY_DB, { schema });
    await db
      .update(schema.workspaces)
      .set({ flagsJson: JSON.stringify({ backgroundWork: false }) })
      .where(eq(schema.workspaces.id, seeded.workspaceId));

    await expect(resolveThreadRuntimeConfigForAgent(env, seeded.threadId)).resolves.toMatchObject({
      backgroundExecEnabled: false,
      subagentsEnabled: false,
    });
  });

  it("falls back to the linked agent model when the thread snapshot is malformed", async () => {
    const seeded = await seedRegisteredThread({
      workspaceId: "workspace-malformed-snapshot",
      threadId: "thr_malformed_snapshot_runtime",
      provider: "mock",
      model: "mock",
      modelInputModalities: ["text"],
      threadProvider: "not-a-provider",
      threadModel: "mock-tool-call",
      threadModelInputModalities: ["text", "image"],
    });

    await expect(resolveThreadRuntimeConfigForAgent(env, seeded.threadId)).resolves.toMatchObject({
      workspaceId: seeded.workspaceId,
      agentId: `agent-${seeded.workspaceId}`,
      modelConfig: {
        provider: "mock",
        model: "mock",
        modelInputModalities: ["text"],
      },
    });
  });
});

describe("mcp oauth callback routing", () => {
  it("does not gate /agents/workspace-mcp-agent/* behind the session auth guard", async () => {
    // The OAuth provider redirects here anonymously; the SDK validates `state`.
    // The auth guard returns 401 for unauthenticated /agents/* — the callback
    // prefix must bypass it and reach routeAgentRequest instead (the SDK answers
    // 404/other for this non-callback request, which is fine; the assertion is
    // "not blocked by the session auth guard").
    const res = await SELF.fetch(
      "https://nadi.test/agents/workspace-mcp-agent/workspace:x/callback",
      { redirect: "manual" },
    );
    expect(res.status).not.toBe(401);
  });

  it("still refuses other /agents/* paths to anonymous callers", async () => {
    const res = await SELF.fetch("https://nadi.test/agents/some-other-agent/some-thread", {
      redirect: "manual",
    });
    expect(res.status).toBe(404);
  });
});
