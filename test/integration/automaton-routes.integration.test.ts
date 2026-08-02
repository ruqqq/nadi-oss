import { SELF, env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../../src/db/schema";
import { applyRegistryTestSchema } from "./helpers/registry";

const now = 1_800_000_000_000;

function cookie(token: string) {
  return { cookie: `better-auth.session_token=${token}` };
}

function db() {
  return drizzle(env.REGISTRY_DB, { schema });
}

async function insertUserSession(input?: { userId?: string; token?: string }) {
  const userId = input?.userId ?? "user-automaton-routes";
  const token = input?.token ?? "automaton-routes-token";

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

  return { userId, token };
}

async function insertWorkspaceMembership(input: {
  userId: string;
  workspaceId: string;
  role?: "owner" | "member";
  memberCreatedAt?: number;
  agentCreatedAt?: number;
}) {
  const role = input.role ?? "owner";

  await db().insert(schema.workspaces).values({
    id: input.workspaceId,
    name: input.workspaceId,
    createdAt: now,
  });
  await db()
    .insert(schema.workspaceMembers)
    .values({
      workspaceId: input.workspaceId,
      userId: input.userId,
      role,
      createdAt: input.memberCreatedAt ?? now,
    });
  await db()
    .insert(schema.agents)
    .values({
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
}) {
  const userId = input?.userId ?? "user-automaton-routes";
  const token = input?.token ?? "automaton-routes-token";
  const workspaceId = input?.workspaceId ?? "workspace-automaton-routes";

  await insertUserSession({ userId, token });
  const workspace = await insertWorkspaceMembership({
    userId,
    workspaceId,
    ...(input?.role ? { role: input.role } : {}),
  });

  return { userId, token, workspaceId, agentId: workspace.agentId };
}

async function insertAutomatonRun(input: {
  id: string;
  automatonId: string;
  workspaceId: string;
  status: "queued" | "running" | "completed" | "waiting_for_approval" | "failed" | "skipped";
  trigger?: "scheduled" | "manual";
  createdAt: number;
}) {
  await env.REGISTRY_DB.prepare(
    "INSERT INTO automaton_runs (id, automaton_id, workspace_id, due_at, trigger, thread_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      input.id,
      input.automatonId,
      input.workspaceId,
      null,
      input.trigger ?? "manual",
      null,
      input.status,
      input.createdAt,
      input.createdAt,
    )
    .run();
}

describe("automaton routes", () => {
  beforeEach(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  it("returns 401 for unauthenticated listings", async () => {
    const res = await SELF.fetch("https://nadi.test/api/automata");
    expect(res.status).toBe(401);
  });

  it("rejects a projectId that is not an active project in the workspace", async () => {
    const seeded = await seedUserWorkspace();

    const res = await SELF.fetch("https://nadi.test/api/automata", {
      method: "POST",
      headers: { ...cookie(seeded.token), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Daily briefing",
        prompt: "Give me my briefing.",
        timezone: "Asia/Singapore",
        schedule: { kind: "daily", hour: 8, minute: 0 },
        projectId: "proj_belongs_to_nobody",
      }),
    });

    // 404, not 403 — we never confirm another workspace's project exists.
    // Accepting this would create an automaton that looks configured and then
    // fails every single run at fire time, with the cause buried in a run row.
    expect(res.status).toBe(404);

    const list = await SELF.fetch("https://nadi.test/api/automata", {
      headers: cookie(seeded.token),
    });
    const body = (await list.json()) as { automata: unknown[] };
    expect(body.automata).toHaveLength(0);
  });

  it("rejects an unknown timezone with 400", async () => {
    const seeded = await seedUserWorkspace();

    const res = await SELF.fetch("https://nadi.test/api/automata", {
      method: "POST",
      headers: { ...cookie(seeded.token), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Daily briefing",
        prompt: "Give me my briefing.",
        timezone: "Not/A_Zone",
        schedule: { kind: "daily", hour: 8, minute: 0 },
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Not/A_Zone");
  });

  it("rejects a cron expression that does not parse with 400", async () => {
    const seeded = await seedUserWorkspace();

    const res = await SELF.fetch("https://nadi.test/api/automata", {
      method: "POST",
      headers: { ...cookie(seeded.token), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Bad cron",
        prompt: "Do the thing.",
        timezone: "UTC",
        schedule: { kind: "cron", expr: "not a cron expression" },
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("cron expression does not parse");
  });

  it("creates an automaton with nextDueAt in the future — enabling never backfills", async () => {
    const seeded = await seedUserWorkspace();
    const before = Date.now();

    const res = await SELF.fetch("https://nadi.test/api/automata", {
      method: "POST",
      headers: { ...cookie(seeded.token), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "  Daily briefing  ",
        prompt: "  Give me my briefing.  ",
        timezone: "Asia/Singapore",
        schedule: { kind: "daily", hour: 8, minute: 0 },
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      automaton: {
        id: string;
        name: string;
        prompt: string;
        nextDueAt: number;
        workspaceId: string;
      };
    };
    expect(body.automaton).toMatchObject({
      name: "Daily briefing",
      prompt: "Give me my briefing.",
      workspaceId: seeded.workspaceId,
    });
    expect(body.automaton.nextDueAt).toBeGreaterThan(before);
  });

  it("recomputes nextDueAt on PATCH when the schedule changes", async () => {
    const seeded = await seedUserWorkspace();

    const createRes = await SELF.fetch("https://nadi.test/api/automata", {
      method: "POST",
      headers: { ...cookie(seeded.token), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Weekly upkeep",
        prompt: "Tidy things up.",
        timezone: "UTC",
        schedule: { kind: "weekly", weekday: 1, hour: 9, minute: 0 },
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { automaton: { id: string; nextDueAt: number } };

    const patchRes = await SELF.fetch(`https://nadi.test/api/automata/${created.automaton.id}`, {
      method: "PATCH",
      headers: { ...cookie(seeded.token), "Content-Type": "application/json" },
      body: JSON.stringify({ schedule: { kind: "daily", hour: 8, minute: 0 } }),
    });
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as {
      automaton: { id: string; nextDueAt: number; scheduleJson: string };
    };

    expect(patched.automaton.scheduleJson).toBe(
      JSON.stringify({ kind: "daily", hour: 8, minute: 0 }),
    );
    expect(patched.automaton.nextDueAt).not.toBe(created.automaton.nextDueAt);
    expect(patched.automaton.nextDueAt).toBeGreaterThan(Date.now());
  });

  it("rejects a PATCH that introduces an invalid schedule with 400, leaving the automaton untouched", async () => {
    const seeded = await seedUserWorkspace();
    const createRes = await SELF.fetch("https://nadi.test/api/automata", {
      method: "POST",
      headers: { ...cookie(seeded.token), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Daily briefing",
        prompt: "Give me my briefing.",
        timezone: "UTC",
        schedule: { kind: "daily", hour: 8, minute: 0 },
      }),
    });
    const created = (await createRes.json()) as { automaton: { id: string; nextDueAt: number } };

    const patchRes = await SELF.fetch(`https://nadi.test/api/automata/${created.automaton.id}`, {
      method: "PATCH",
      headers: { ...cookie(seeded.token), "Content-Type": "application/json" },
      body: JSON.stringify({ timezone: "Not/A_Zone" }),
    });
    expect(patchRes.status).toBe(400);

    const getRes = await SELF.fetch(`https://nadi.test/api/automata/${created.automaton.id}`, {
      headers: cookie(seeded.token),
    });
    const fetched = (await getRes.json()) as { automaton: { nextDueAt: number } };
    expect(fetched.automaton.nextDueAt).toBe(created.automaton.nextDueAt);
  });

  it("soft-deletes on DELETE so the automaton disappears from the list but a direct GET still 404s", async () => {
    const seeded = await seedUserWorkspace();
    const createRes = await SELF.fetch("https://nadi.test/api/automata", {
      method: "POST",
      headers: { ...cookie(seeded.token), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Markdump upkeep",
        prompt: "Tidy the markdump.",
        timezone: "UTC",
        schedule: { kind: "weekly", weekday: 1, hour: 9, minute: 0 },
      }),
    });
    const created = (await createRes.json()) as { automaton: { id: string } };

    const listBefore = await SELF.fetch("https://nadi.test/api/automata", {
      headers: cookie(seeded.token),
    });
    const bodyBefore = (await listBefore.json()) as { automata: { id: string }[] };
    expect(bodyBefore.automata.map((a) => a.id)).toContain(created.automaton.id);

    const deleteRes = await SELF.fetch(`https://nadi.test/api/automata/${created.automaton.id}`, {
      method: "DELETE",
      headers: cookie(seeded.token),
    });
    expect(deleteRes.status).toBe(200);
    const deleted = (await deleteRes.json()) as { automaton: { archivedAt: number | null } };
    expect(deleted.automaton.archivedAt).toEqual(expect.any(Number));

    const listAfter = await SELF.fetch("https://nadi.test/api/automata", {
      headers: cookie(seeded.token),
    });
    const bodyAfter = (await listAfter.json()) as { automata: { id: string }[] };
    expect(bodyAfter.automata.map((a) => a.id)).not.toContain(created.automaton.id);

    // Archived automata read as gone everywhere, not just the list.
    const getRes = await SELF.fetch(`https://nadi.test/api/automata/${created.automaton.id}`, {
      headers: cookie(seeded.token),
    });
    expect(getRes.status).toBe(404);
  });

  it("returns 404, not 403, for a non-member touching GET/PATCH/DELETE", async () => {
    const owner = await seedUserWorkspace();
    const createRes = await SELF.fetch("https://nadi.test/api/automata", {
      method: "POST",
      headers: { ...cookie(owner.token), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Owner's automaton",
        prompt: "Do the thing.",
        timezone: "UTC",
        schedule: { kind: "daily", hour: 8, minute: 0 },
      }),
    });
    const created = (await createRes.json()) as { automaton: { id: string } };

    const outsider = await seedUserWorkspace({
      userId: "user-automaton-outsider",
      token: "automaton-outsider-token",
      workspaceId: "workspace-automaton-outsider",
    });

    const getRes = await SELF.fetch(`https://nadi.test/api/automata/${created.automaton.id}`, {
      headers: cookie(outsider.token),
    });
    expect(getRes.status).toBe(404);

    const patchRes = await SELF.fetch(`https://nadi.test/api/automata/${created.automaton.id}`, {
      method: "PATCH",
      headers: { ...cookie(outsider.token), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Hijacked" }),
    });
    expect(patchRes.status).toBe(404);

    const deleteRes = await SELF.fetch(`https://nadi.test/api/automata/${created.automaton.id}`, {
      method: "DELETE",
      headers: cookie(outsider.token),
    });
    expect(deleteRes.status).toBe(404);

    const runRes = await SELF.fetch(`https://nadi.test/api/automata/${created.automaton.id}/run`, {
      method: "POST",
      headers: cookie(outsider.token),
    });
    expect(runRes.status).toBe(404);
  });

  it("includes lastRun in the list response", async () => {
    const seeded = await seedUserWorkspace();
    const createRes = await SELF.fetch("https://nadi.test/api/automata", {
      method: "POST",
      headers: { ...cookie(seeded.token), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Daily briefing",
        prompt: "Give me my briefing.",
        timezone: "UTC",
        schedule: { kind: "daily", hour: 8, minute: 0 },
      }),
    });
    const created = (await createRes.json()) as { automaton: { id: string } };

    const noRunYet = await SELF.fetch("https://nadi.test/api/automata", {
      headers: cookie(seeded.token),
    });
    const bodyNoRun = (await noRunYet.json()) as {
      automata: { id: string; lastRun: unknown }[];
    };
    expect(bodyNoRun.automata.find((a) => a.id === created.automaton.id)?.lastRun).toBeNull();

    await insertAutomatonRun({
      id: "arun_routes_1",
      automatonId: created.automaton.id,
      workspaceId: seeded.workspaceId,
      status: "completed",
      createdAt: now,
    });
    await insertAutomatonRun({
      id: "arun_routes_2",
      automatonId: created.automaton.id,
      workspaceId: seeded.workspaceId,
      status: "failed",
      createdAt: now + 1000,
    });

    const withRun = await SELF.fetch("https://nadi.test/api/automata", {
      headers: cookie(seeded.token),
    });
    const bodyWithRun = (await withRun.json()) as {
      automata: { id: string; lastRun: { id: string; status: string } | null }[];
    };
    const row = bodyWithRun.automata.find((a) => a.id === created.automaton.id);
    expect(row?.lastRun?.id).toBe("arun_routes_2");
    expect(row?.lastRun?.status).toBe("failed");
  });

  it("accepts and persists notifyMode on create, defaulting to all", async () => {
    const seeded = await seedUserWorkspace();

    const res = await SELF.fetch("https://nadi.test/api/automata", {
      method: "POST",
      headers: { ...cookie(seeded.token), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Failures only",
        prompt: "Watch for failures.",
        timezone: "UTC",
        schedule: { kind: "daily", hour: 8, minute: 0 },
        notifyMode: "failures_only",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { automaton: { notifyMode: string } };
    expect(body.automaton.notifyMode).toBe("failures_only");

    const defaultRes = await SELF.fetch("https://nadi.test/api/automata", {
      method: "POST",
      headers: { ...cookie(seeded.token), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Default notify",
        prompt: "Give me my briefing.",
        timezone: "UTC",
        schedule: { kind: "daily", hour: 8, minute: 0 },
      }),
    });
    expect(defaultRes.status).toBe(201);
    const defaultBody = (await defaultRes.json()) as { automaton: { notifyMode: string } };
    expect(defaultBody.automaton.notifyMode).toBe("all");
  });

  it("rejects an invalid notifyMode on create", async () => {
    const seeded = await seedUserWorkspace();

    const res = await SELF.fetch("https://nadi.test/api/automata", {
      method: "POST",
      headers: { ...cookie(seeded.token), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Bad notify",
        prompt: "Do the thing.",
        timezone: "UTC",
        schedule: { kind: "daily", hour: 8, minute: 0 },
        notifyMode: "loud",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("notifyMode");
  });

  it("rejects an invalid notifyMode on patch", async () => {
    const seeded = await seedUserWorkspace();
    const createRes = await SELF.fetch("https://nadi.test/api/automata", {
      method: "POST",
      headers: { ...cookie(seeded.token), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Daily briefing",
        prompt: "Give me my briefing.",
        timezone: "UTC",
        schedule: { kind: "daily", hour: 8, minute: 0 },
      }),
    });
    const created = (await createRes.json()) as { automaton: { id: string } };

    const patchRes = await SELF.fetch(`https://nadi.test/api/automata/${created.automaton.id}`, {
      method: "PATCH",
      headers: { ...cookie(seeded.token), "Content-Type": "application/json" },
      body: JSON.stringify({ notifyMode: "loud" }),
    });
    expect(patchRes.status).toBe(400);

    const getRes = await SELF.fetch(`https://nadi.test/api/automata/${created.automaton.id}`, {
      headers: cookie(seeded.token),
    });
    const fetched = (await getRes.json()) as { automaton: { notifyMode: string } };
    expect(fetched.automaton.notifyMode).toBe("all");
  });

  it("updates notifyMode on patch", async () => {
    const seeded = await seedUserWorkspace();
    const createRes = await SELF.fetch("https://nadi.test/api/automata", {
      method: "POST",
      headers: { ...cookie(seeded.token), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Daily briefing",
        prompt: "Give me my briefing.",
        timezone: "UTC",
        schedule: { kind: "daily", hour: 8, minute: 0 },
      }),
    });
    const created = (await createRes.json()) as { automaton: { id: string } };

    const patchRes = await SELF.fetch(`https://nadi.test/api/automata/${created.automaton.id}`, {
      method: "PATCH",
      headers: { ...cookie(seeded.token), "Content-Type": "application/json" },
      body: JSON.stringify({ notifyMode: "failures_only" }),
    });
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as { automaton: { notifyMode: string } };
    expect(patched.automaton.notifyMode).toBe("failures_only");
  });

  it("uses the same default-workspace resolution as other create flows", async () => {
    const seeded = await seedUserWorkspace();

    const res = await SELF.fetch("https://nadi.test/api/automata", {
      method: "POST",
      headers: { ...cookie(seeded.token), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Daily briefing",
        prompt: "Give me my briefing.",
        timezone: "UTC",
        schedule: { kind: "daily", hour: 8, minute: 0 },
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      automaton: { id: string; workspaceId: string; agentId: string };
    };
    expect(body.automaton.workspaceId).toBe(seeded.workspaceId);
    expect(body.automaton.agentId).toBe(seeded.agentId);

    const row = await db()
      .select()
      .from(schema.automata)
      .where(eq(schema.automata.id, body.automaton.id))
      .get();
    expect(row?.workspaceId).toBe(seeded.workspaceId);
    expect(row?.ownerUserId).toBe(seeded.userId);
  });

  it("accepts and persists workbenchId on create", async () => {
    const seeded = await seedUserWorkspace();
    const workbenchId = "wbk_routes_test";
    await db().insert(schema.workbenches).values({
      id: workbenchId,
      workspaceId: seeded.workspaceId,
      name: "Routes test workbench",
      description: "",
      setupScript: "",
      sandboxEnvVarsJson: "{}",
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    const res = await SELF.fetch("https://nadi.test/api/automata", {
      method: "POST",
      headers: { ...cookie(seeded.token), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Daily briefing",
        prompt: "Give me my briefing.",
        timezone: "UTC",
        schedule: { kind: "hourly", minute: 0 },
        workbenchId,
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { automaton: { workbenchId: string | null } };
    expect(body.automaton.workbenchId).toBe(workbenchId);
  });

  it("rejects a workbenchId that is not an active workbench in the workspace", async () => {
    const seeded = await seedUserWorkspace();

    const res = await SELF.fetch("https://nadi.test/api/automata", {
      method: "POST",
      headers: { ...cookie(seeded.token), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Daily briefing",
        prompt: "Give me my briefing.",
        timezone: "UTC",
        schedule: { kind: "hourly", minute: 0 },
        workbenchId: "wbk_missing",
      }),
    });

    expect(res.status).toBe(404);
  });
});
