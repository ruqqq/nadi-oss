import { SELF, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../src/db/schema";
import { GithubInstallationRepository } from "../../src/db/repositories/github-installations";
import { GithubInstallationGoneError } from "../../src/github/app-client";
import { routeGithub } from "../../src/http/github-routes";
import { applyRegistryTestSchema } from "./helpers/registry";
import { signGithubState } from "../../src/github/state";
import { getGithubAppConfig } from "../../src/github/config";

const now = 1_800_000_000_000;

function cookie(token: string) {
  return { cookie: `better-auth.session_token=${token}` };
}

async function clearRegistry() {
  const db = drizzle(env.REGISTRY_DB, { schema });
  await db.delete(schema.agentRepositories);
  await db.delete(schema.githubAppInstallations);
  await db.delete(schema.agents);
  await db.delete(schema.workspaceMembers);
  await db.delete(schema.workspaces);
  await db.delete(schema.sessions);
  await db.delete(schema.users);
}

async function insertUserSession(input?: { userId?: string; token?: string }) {
  const db = drizzle(env.REGISTRY_DB, { schema });
  const userId = input?.userId ?? "user-github-routes";
  const token = input?.token ?? "github-routes-token";

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

async function insertWorkspaceMembership(input: { userId: string; workspaceId: string }) {
  const db = drizzle(env.REGISTRY_DB, { schema });

  await db.insert(schema.workspaces).values({
    id: input.workspaceId,
    name: input.workspaceId,
    createdAt: now,
  });
  await db.insert(schema.workspaceMembers).values({
    workspaceId: input.workspaceId,
    userId: input.userId,
    role: "owner",
    createdAt: now,
  });
  await db.insert(schema.agents).values({
    id: `agent-${input.workspaceId}`,
    workspaceId: input.workspaceId,
    name: "Default",
    systemPrompt: "You are Nadi.",
    provider: "mock",
    model: "mock",
    createdAt: now,
  });

  return { workspaceId: input.workspaceId };
}

async function seedOwner() {
  const { userId, token } = await insertUserSession();
  const workspaceId = "workspace-github-routes";
  await insertWorkspaceMembership({ userId, workspaceId });
  return { userId, token, workspaceId };
}

describe("github routes", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  beforeEach(async () => {
    await clearRegistry();
  });

  afterEach(async () => {
    await clearRegistry();
  });

  it("returns 401 without a session", async () => {
    const res = await SELF.fetch("https://nadi.test/api/settings/github");
    expect(res.status).toBe(401);
  });

  it("lists installations for the owner with configured=true", async () => {
    const seeded = await seedOwner();
    await new GithubInstallationRepository(drizzle(env.REGISTRY_DB, { schema })).upsert({
      workspaceId: seeded.workspaceId,
      installationId: 42,
      accountLogin: "acme",
      accountType: "org",
      repositorySelection: "all",
      connectedByUserId: seeded.userId,
    });

    const res = await SELF.fetch("https://nadi.test/api/settings/github", {
      headers: cookie(seeded.token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      configured: boolean;
      installations: Array<{ accountLogin: string }>;
    };
    expect(body.configured).toBe(true);
    expect(body.installations[0]?.accountLogin).toBe("acme");
  });

  it("disconnects an installation", async () => {
    const seeded = await seedOwner();
    await new GithubInstallationRepository(drizzle(env.REGISTRY_DB, { schema })).upsert({
      workspaceId: seeded.workspaceId,
      installationId: 42,
      accountLogin: "acme",
      accountType: "org",
      repositorySelection: "all",
      connectedByUserId: seeded.userId,
    });

    const disconnectRes = await SELF.fetch("https://nadi.test/api/settings/github/disconnect", {
      method: "POST",
      headers: { ...cookie(seeded.token), "content-type": "application/json" },
      body: JSON.stringify({ installationId: 42 }),
    });
    expect(disconnectRes.status).toBe(200);
    await expect(disconnectRes.json()).resolves.toEqual({ ok: true });

    const listRes = await SELF.fetch("https://nadi.test/api/settings/github", {
      headers: cookie(seeded.token),
    });
    const body = (await listRes.json()) as { installations: Array<{ status: string }> };
    expect(body.installations[0]?.status).toBe("disconnected");
  });

  it("returns null for unrelated paths when called directly", async () => {
    const res = await routeGithub(new Request("https://nadi.test/api/other"), env);
    expect(res).toBeNull();
  });

  it("connect redirects to the GitHub install URL with a signed state", async () => {
    const { token } = await seedOwner();
    const res = await routeGithub(
      new Request("https://nadi.test/api/settings/github/connect", { headers: cookie(token) }),
      env,
    );
    expect(res?.status).toBe(302);
    const loc = res!.headers.get("location")!;
    expect(loc).toContain("github.com/apps/");
    expect(loc).toContain("state=");
  });

  it("callback records the installation and redirects to settings", async () => {
    const { token, userId, workspaceId } = await seedOwner();
    const config = getGithubAppConfig(env)!;
    const state = await signGithubState(config.clientSecret, {
      workspaceId,
      userId,
      nonce: "n",
      exp: Date.now() + 60_000,
    });
    const fakeClient = {
      exchangeOAuthCode: async () => ({ accessToken: "gho_user" }),
      getAuthenticatedUser: async () => ({ login: "octocat", id: 1 }),
      getInstallation: async () => ({
        accountLogin: "acme",
        accountType: "org" as const,
        repositorySelection: "all" as const,
      }),
    };
    const url = `https://nadi.test/api/github/callback?installation_id=42&setup_action=install&code=abc&state=${encodeURIComponent(state)}`;
    const res = await routeGithub(new Request(url, { headers: cookie(token) }), env, {
      clientFactory: () => fakeClient as never,
    });
    expect(res?.status).toBe(302);
    expect(res!.headers.get("location")).toContain("/settings/github?connected=1");
    const list = await routeGithub(
      new Request("https://nadi.test/api/settings/github", { headers: cookie(token) }),
      env,
    );
    expect(
      ((await list!.json()) as { installations: { installationId: number }[] }).installations[0]!
        .installationId,
    ).toBe(42);
  });

  it("callback rejects a state-bound workspace the session user no longer owns", async () => {
    const { token, userId } = await seedOwner();
    const config = getGithubAppConfig(env)!;
    // Sign a state for a workspace the authenticated user does NOT own (e.g. they
    // were demoted or the state was bound to a different workspace than their own).
    const state = await signGithubState(config.clientSecret, {
      workspaceId: "workspace-not-owned",
      userId,
      nonce: "n",
      exp: Date.now() + 60_000,
    });
    const fakeClient = {
      exchangeOAuthCode: async () => ({ accessToken: "gho_user" }),
      getAuthenticatedUser: async () => ({ login: "octocat", id: 1 }),
      getInstallation: async () => ({
        accountLogin: "acme",
        accountType: "org" as const,
        repositorySelection: "all" as const,
      }),
    };
    const url = `https://nadi.test/api/github/callback?installation_id=42&code=abc&state=${encodeURIComponent(state)}`;
    const res = await routeGithub(new Request(url, { headers: cookie(token) }), env, {
      clientFactory: () => fakeClient as never,
    });
    expect(res?.status).toBe(302);
    expect(res!.headers.get("location")).toContain("error=");

    const rows = await drizzle(env.REGISTRY_DB, { schema })
      .select()
      .from(schema.githubAppInstallations);
    expect(rows).toHaveLength(0);
  });

  it("marks the installation disconnected when the client reports the installation is gone", async () => {
    const seeded = await seedOwner();
    const installRepo = new GithubInstallationRepository(drizzle(env.REGISTRY_DB, { schema }));
    await installRepo.upsert({
      workspaceId: seeded.workspaceId,
      installationId: 42,
      accountLogin: "acme",
      accountType: "org",
      repositorySelection: "all",
      connectedByUserId: seeded.userId,
    });

    const fakeClient = {
      listInstallationRepositories: async () => {
        throw new GithubInstallationGoneError(42, 404);
      },
    };
    const res = await routeGithub(
      new Request("https://nadi.test/api/settings/github/installations/42/repositories", {
        headers: cookie(seeded.token),
      }),
      env,
      { clientFactory: () => fakeClient as never },
    );
    expect(res?.status).toBe(409);
    await expect(res!.json()).resolves.toEqual({ error: "installation_disconnected" });

    const installations = await installRepo.listForWorkspace(seeded.workspaceId);
    expect(installations[0]?.status).toBe("disconnected");
  });

  it("returns 404 for an installationId that belongs to a different workspace", async () => {
    const seeded = await seedOwner();
    const otherWorkspaceId = "workspace-github-routes-other";
    const { userId: otherOwnerId } = await insertUserSession({
      userId: "other-owner",
      token: "other-owner-token",
    });
    await insertWorkspaceMembership({ userId: otherOwnerId, workspaceId: otherWorkspaceId });
    await new GithubInstallationRepository(drizzle(env.REGISTRY_DB, { schema })).upsert({
      workspaceId: otherWorkspaceId,
      installationId: 99,
      accountLogin: "other",
      accountType: "org",
      repositorySelection: "all",
      connectedByUserId: "other-owner",
    });

    const res = await routeGithub(
      new Request("https://nadi.test/api/settings/github/installations/99/repositories", {
        headers: cookie(seeded.token),
      }),
      env,
    );
    expect(res?.status).toBe(404);
  });

  it("callback rejects a state whose user != session user", async () => {
    const { token } = await seedOwner();
    const config = getGithubAppConfig(env)!;
    const state = await signGithubState(config.clientSecret, {
      workspaceId: "ws-other",
      userId: "someone-else",
      nonce: "n",
      exp: Date.now() + 60_000,
    });
    const url = `https://nadi.test/api/github/callback?installation_id=42&code=abc&state=${encodeURIComponent(state)}`;
    const res = await routeGithub(new Request(url, { headers: cookie(token) }), env);
    expect(res?.status).toBe(302);
    expect(res!.headers.get("location")).toContain("error=");
  });
});
