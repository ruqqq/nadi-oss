import { SELF, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { applyRegistryTestSchema } from "./helpers/registry";

const now = 1_800_000_000_000;

function cookie(token: string) {
  return { cookie: `better-auth.session_token=${token}` };
}

async function clearRegistry() {
  const db = drizzle(env.REGISTRY_DB, { schema });
  await db.delete(schema.threadIndex);
  await db.delete(schema.projects);
  await db.delete(schema.agents);
  await db.delete(schema.workspaceMembers);
  await db.delete(schema.workspaces);
  await db.delete(schema.sessions);
  await db.delete(schema.users);
}

async function insertUserSession(input?: { userId?: string; token?: string }) {
  const db = drizzle(env.REGISTRY_DB, { schema });
  const userId = input?.userId ?? "user-project-routes";
  const token = input?.token ?? "project-routes-token";

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

async function insertWorkspaceMembership(input: {
  userId: string;
  workspaceId: string;
  role?: "owner" | "member";
  memberCreatedAt?: number;
  agentCreatedAt?: number;
}) {
  const db = drizzle(env.REGISTRY_DB, { schema });
  const role = input.role ?? "owner";

  await db.insert(schema.workspaces).values({
    id: input.workspaceId,
    name: input.workspaceId,
    createdAt: now,
  });
  await db.insert(schema.workspaceMembers).values({
    workspaceId: input.workspaceId,
    userId: input.userId,
    role,
    createdAt: input.memberCreatedAt ?? now,
  });
  await db.insert(schema.agents).values({
    id: `agent-${input.workspaceId}`,
    workspaceId: input.workspaceId,
    name: "Default",
    systemPrompt: "You are Nadi.",
    provider: "mock",
    model: "mock",
    createdAt: input.agentCreatedAt ?? now,
  });

  return { workspaceId: input.workspaceId, agentId: `agent-${input.workspaceId}` };
}

async function seedUserWorkspace(input?: {
  userId?: string;
  token?: string;
  workspaceId?: string;
  role?: "owner" | "member";
  memberCreatedAt?: number;
  agentCreatedAt?: number;
}) {
  const userId = input?.userId ?? "user-project-routes";
  const token = input?.token ?? "project-routes-token";
  const workspaceId = input?.workspaceId ?? "workspace-project-routes";

  await insertUserSession({ userId, token });
  const workspace = await insertWorkspaceMembership({
    userId,
    workspaceId,
    ...(input?.role ? { role: input.role } : {}),
    ...(input?.memberCreatedAt !== undefined ? { memberCreatedAt: input.memberCreatedAt } : {}),
    ...(input?.agentCreatedAt !== undefined ? { agentCreatedAt: input.agentCreatedAt } : {}),
  });

  return { userId, token, workspaceId, agentId: workspace.agentId };
}

async function insertProject(input: {
  id: string;
  workspaceId: string;
  name: string;
  createdAt: number;
}) {
  await drizzle(env.REGISTRY_DB, { schema }).insert(schema.projects).values({
    id: input.id,
    workspaceId: input.workspaceId,
    name: input.name,
    description: "",
    customInstructions: "",
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
}

async function insertEnvironment(input: {
  id: string;
  workspaceId: string;
  name: string;
  createdAt: number;
}) {
  const db = drizzle(env.REGISTRY_DB, { schema });
  await db.insert(schema.agents).values({
    id: input.id,
    workspaceId: input.workspaceId,
    name: input.name,
    // An environment IS an agent now.
    systemPrompt: "You are Nadi.",
    provider: "mock",
    model: "mock",
    description: "",
    setupScript: "",
    sandboxEnvVarsJson: "{}",
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
}

async function insertThread(input: {
  id: string;
  workspaceId: string;
  agentId: string;
  projectId: string | null;
  createdAt: number;
}) {
  await drizzle(env.REGISTRY_DB, { schema })
    .insert(schema.threadIndex)
    .values({
      id: input.id,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      projectId: input.projectId,
      modelProvider: "mock",
      model: "mock",
      modelInputModalities: JSON.stringify(["text"]),
      title: input.id,
      runtime: "legacy",
      source: "manual",
      automatonId: null,
      automatonRunId: null,
      lastEventId: null,
      lastMessagePreview: "",
      archivedAt: null,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    });
}

describe("project routes", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  beforeEach(async () => {
    await clearRegistry();
  });

  afterEach(async () => {
    await clearRegistry();
  });

  it("returns 401 for unauthenticated project listings", async () => {
    const res = await SELF.fetch("https://nadi.test/api/projects");

    expect(res.status).toBe(401);
  });

  it("creates a project", async () => {
    const seeded = await seedUserWorkspace();

    const createRes = await SELF.fetch("https://nadi.test/api/projects", {
      method: "POST",
      headers: { ...cookie(seeded.token), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "  Nadi Routes  ",
        description: "  Route coverage  ",
        customInstructions: "  Keep the repo clean.  ",
      }),
    });

    expect(createRes.status).toBe(201);
    const createdBody = (await createRes.json()) as { project: { id: string; name: string } };
    expect(createdBody.project).toMatchObject({
      id: expect.any(String),
      name: "Nadi Routes",
      description: "Route coverage",
      customInstructions: "Keep the repo clean.",
      archivedAt: null,
    });
  });

  it("uses the same default workspace as current thread and settings flows", async () => {
    const seeded = await insertUserSession({
      userId: "user-project-multi-workspace",
      token: "project-multi-workspace-token",
    });
    const primary = await insertWorkspaceMembership({
      userId: seeded.userId,
      workspaceId: "workspace-project-primary",
      role: "owner",
      memberCreatedAt: now,
      agentCreatedAt: now,
    });
    await insertWorkspaceMembership({
      userId: seeded.userId,
      workspaceId: "workspace-project-secondary",
      role: "owner",
      memberCreatedAt: now + 1,
      agentCreatedAt: now + 1,
    });
    await insertProject({
      id: "project-primary",
      workspaceId: primary.workspaceId,
      name: "Primary",
      createdAt: now,
    });
    await insertProject({
      id: "project-secondary",
      workspaceId: "workspace-project-secondary",
      name: "Secondary",
      createdAt: now + 1,
    });

    const settingsRes = await SELF.fetch("https://nadi.test/api/settings/agents/default", {
      headers: cookie(seeded.token),
    });
    expect(settingsRes.status).toBe(200);
    const settingsBody = (await settingsRes.json()) as { workspace: { id: string } };
    expect(settingsBody.workspace.id).toBe(primary.workspaceId);

    const threadRes = await SELF.fetch("https://nadi.test/api/threads", {
      method: "POST",
      headers: cookie(seeded.token),
    });
    expect(threadRes.status).toBe(201);
    const threadBody = (await threadRes.json()) as { thread: { workspaceId: string } };
    expect(threadBody.thread.workspaceId).toBe(primary.workspaceId);

    const listRes = await SELF.fetch("https://nadi.test/api/projects?status=all", {
      headers: cookie(seeded.token),
    });
    expect(listRes.status).toBe(200);
    await expect(listRes.json()).resolves.toEqual({
      projects: [
        expect.objectContaining({ id: "project-primary", workspaceId: primary.workspaceId }),
      ],
    });

    const createRes = await SELF.fetch("https://nadi.test/api/projects", {
      method: "POST",
      headers: { ...cookie(seeded.token), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Created in primary" }),
    });
    expect(createRes.status).toBe(201);
    await expect(createRes.json()).resolves.toEqual({
      project: expect.objectContaining({
        workspaceId: primary.workspaceId,
        name: "Created in primary",
      }),
    });
  });

  it("returns 404 when loading a project from another workspace", async () => {
    await seedUserWorkspace();
    const other = await seedUserWorkspace({
      userId: "other-project-user",
      token: "other-project-token",
      workspaceId: "workspace-project-other",
      memberCreatedAt: now + 1,
      agentCreatedAt: now + 1,
    });
    await insertProject({
      id: "project-other-workspace",
      workspaceId: other.workspaceId,
      name: "Other",
      createdAt: now,
    });

    const res = await SELF.fetch("https://nadi.test/api/projects/project-other-workspace", {
      headers: cookie("project-routes-token"),
    });

    expect(res.status).toBe(404);
  });

  it("archives a project without changing assigned threads", async () => {
    const seeded = await seedUserWorkspace();
    await insertProject({
      id: "project-archive",
      workspaceId: seeded.workspaceId,
      name: "Archive Me",
      createdAt: now,
    });
    await insertThread({
      id: "thread-project-archive",
      workspaceId: seeded.workspaceId,
      agentId: seeded.agentId,
      projectId: "project-archive",
      createdAt: now,
    });

    const res = await SELF.fetch("https://nadi.test/api/projects/project-archive/archive", {
      method: "POST",
      headers: cookie(seeded.token),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { project: { archivedAt: number | null } };
    expect(body.project.archivedAt).toEqual(expect.any(Number));

    const thread = await drizzle(env.REGISTRY_DB, { schema })
      .select()
      .from(schema.threadIndex)
      .where(eq(schema.threadIndex.id, "thread-project-archive"))
      .get();
    expect(thread?.projectId).toBe("project-archive");
  });

  it("sets and returns a project's default workbench", async () => {
    const seeded = await seedUserWorkspace();
    await insertProject({
      id: "project-default-env",
      workspaceId: seeded.workspaceId,
      name: "Default Env",
      createdAt: now,
    });
    await insertEnvironment({
      id: "env-default",
      workspaceId: seeded.workspaceId,
      name: "Staging",
      createdAt: now,
    });

    const patchRes = await SELF.fetch("https://nadi.test/api/projects/project-default-env", {
      method: "PATCH",
      headers: { ...cookie(seeded.token), "Content-Type": "application/json" },
      body: JSON.stringify({ defaultWorkbenchId: "env-default" }),
    });

    expect(patchRes.status).toBe(200);
    const patchBody = (await patchRes.json()) as {
      project: { defaultWorkbenchId: string | null };
    };
    expect(patchBody.project.defaultWorkbenchId).toBe("env-default");

    const getRes = await SELF.fetch("https://nadi.test/api/projects/project-default-env", {
      headers: cookie(seeded.token),
    });
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as { project: { defaultWorkbenchId: string | null } };
    expect(getBody.project.defaultWorkbenchId).toBe("env-default");
  });

  it("rejects a defaultWorkbenchId for a foreign or nonexistent environment", async () => {
    const seeded = await seedUserWorkspace();
    await insertProject({
      id: "project-bad-env",
      workspaceId: seeded.workspaceId,
      name: "Bad Env",
      createdAt: now,
    });
    const other = await seedUserWorkspace({
      userId: "other-project-env-user",
      token: "other-project-env-token",
      workspaceId: "workspace-project-env-other",
      memberCreatedAt: now + 1,
      agentCreatedAt: now + 1,
    });
    await insertEnvironment({
      id: "env-foreign",
      workspaceId: other.workspaceId,
      name: "Foreign",
      createdAt: now,
    });

    const foreignRes = await SELF.fetch("https://nadi.test/api/projects/project-bad-env", {
      method: "PATCH",
      headers: { ...cookie(seeded.token), "Content-Type": "application/json" },
      body: JSON.stringify({ defaultWorkbenchId: "env-foreign" }),
    });
    expect(foreignRes.status).toBe(404);

    const missingRes = await SELF.fetch("https://nadi.test/api/projects/project-bad-env", {
      method: "PATCH",
      headers: { ...cookie(seeded.token), "Content-Type": "application/json" },
      body: JSON.stringify({ defaultWorkbenchId: "env-does-not-exist" }),
    });
    expect(missingRes.status).toBe(404);
  });

  it("clears a project's default workbench when set to null", async () => {
    const seeded = await seedUserWorkspace();
    await insertProject({
      id: "project-clear-env",
      workspaceId: seeded.workspaceId,
      name: "Clear Env",
      createdAt: now,
    });
    await insertEnvironment({
      id: "env-clear",
      workspaceId: seeded.workspaceId,
      name: "Prod",
      createdAt: now,
    });
    const setRes = await SELF.fetch("https://nadi.test/api/projects/project-clear-env", {
      method: "PATCH",
      headers: { ...cookie(seeded.token), "Content-Type": "application/json" },
      body: JSON.stringify({ defaultWorkbenchId: "env-clear" }),
    });
    expect(setRes.status).toBe(200);

    const clearRes = await SELF.fetch("https://nadi.test/api/projects/project-clear-env", {
      method: "PATCH",
      headers: { ...cookie(seeded.token), "Content-Type": "application/json" },
      body: JSON.stringify({ defaultWorkbenchId: null }),
    });

    expect(clearRes.status).toBe(200);
    const clearBody = (await clearRes.json()) as {
      project: { defaultWorkbenchId: string | null };
    };
    expect(clearBody.project.defaultWorkbenchId).toBeNull();
  });
});
