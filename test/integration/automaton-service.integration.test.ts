import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../../src/db/schema";
import { applyRegistryTestSchema } from "./helpers/registry";
import { WorkspaceRepository } from "../../src/db/repositories/workspaces";
import { AutomatonRepository } from "../../src/db/repositories/automata";
import { WorkbenchRepository } from "../../src/db/repositories/workbenches";
import { startAutomatonRun } from "../../src/automata/fire-due";
import {
  AutomatonService,
  AutomatonValidationError,
  AutomatonProjectNotFoundError,
  AutomatonNotFoundError,
} from "../../src/automata/service";

const now = 1_800_000_000_000;
function db() {
  return drizzle(env.REGISTRY_DB, { schema });
}

// Seeds a workspace with an owner membership and a valid default agent, and
// returns the ids a service context needs.
async function seedWorkspace(suffix: string) {
  const workspaceId = `ws_${suffix}`;
  const ownerUserId = `user_${suffix}`;
  const agentId = `agt_${suffix}`;
  await db()
    .insert(schema.users)
    .values({
      id: ownerUserId,
      email: `${ownerUserId}@example.com`,
      name: null,
      createdAt: new Date(now),
      emailVerified: true,
      image: null,
      updatedAt: new Date(now),
    });
  await db()
    .insert(schema.workspaces)
    .values({ id: workspaceId, name: workspaceId, createdAt: now });
  await db().insert(schema.workspaceMembers).values({
    workspaceId,
    userId: ownerUserId,
    role: "owner",
    createdAt: now,
  });
  await db().insert(schema.agents).values({
    id: agentId,
    workspaceId,
    name: "Default",
    systemPrompt: "You are helpful.",
    provider: "anthropic",
    model: "claude-sonnet-5",
    createdAt: now,
  });
  return { workspaceId, ownerUserId, agentId };
}

// Seeds a second active AGENT in the workspace and returns its id. An agent is
// what a workbench became.
async function seedWorkbench(workspaceId: string) {
  const id = `wbk_${crypto.randomUUID()}`;
  await db().insert(schema.agents).values({
    id,
    workspaceId,
    name: id,
    systemPrompt: "You are Nadi.",
    provider: "mock",
    model: "mock",
    description: "",
    setupScript: "",
    sandboxEnvVarsJson: "{}",
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

// Seeds a project with the given default agent and returns its id.
async function seedProject(workspaceId: string, defaultWorkbenchId: string) {
  const id = `prj_${crypto.randomUUID()}`;
  await db().insert(schema.projects).values({
    id,
    workspaceId,
    name: id,
    description: "",
    customInstructions: "",
    defaultAgentId: defaultWorkbenchId,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

function service(ctx: {
  workspaceId: string;
  ownerUserId: string;
  agentId: string;
  viewerEmail?: string | null;
}) {
  return new AutomatonService(db(), {
    env,
    workspaceId: ctx.workspaceId,
    ownerUserId: ctx.ownerUserId,
    agentId: ctx.agentId,
    viewerEmail: ctx.viewerEmail ?? `${ctx.ownerUserId}@example.com`,
  });
}

describe("WorkspaceRepository.getOwnerUserId", () => {
  beforeEach(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  it("returns the owner membership's user id", async () => {
    const seeded = await seedWorkspace("owner");
    const ownerId = await new WorkspaceRepository(db()).getOwnerUserId(seeded.workspaceId);
    expect(ownerId).toBe(seeded.ownerUserId);
  });

  it("returns null for a workspace with no owner", async () => {
    const ownerId = await new WorkspaceRepository(db()).getOwnerUserId("ws_missing");
    expect(ownerId).toBeNull();
  });
});

describe("AutomatonService", () => {
  beforeEach(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  it("create computes a future nextDueAt and stamps owner/agent/workspace", async () => {
    const seeded = await seedWorkspace("create");
    const before = Date.now();
    const row = await service(seeded).create({
      name: "Daily briefing",
      prompt: "Summarize today.",
      timezone: "Asia/Singapore",
      schedule: { kind: "daily", hour: 8, minute: 0 },
    });
    expect(row.nextDueAt).toBeGreaterThan(before);
    expect(row.workspaceId).toBe(seeded.workspaceId);
    expect(row.ownerUserId).toBe(seeded.ownerUserId);
    expect(row.agentId).toBe(seeded.agentId);
    expect(row.enabled).toBe(true);
    expect(row.notifyMode).toBe("all");
    expect(row.disabledReason).toBeNull();
  });

  it("create rejects an unknown timezone with a validation error", async () => {
    const seeded = await seedWorkspace("tz");
    await expect(
      service(seeded).create({
        name: "x",
        prompt: "y",
        timezone: "Not/A_Zone",
        schedule: { kind: "daily", hour: 8, minute: 0 },
      }),
    ).rejects.toBeInstanceOf(AutomatonValidationError);
  });

  it("create rejects a bad cron schedule with a validation error", async () => {
    const seeded = await seedWorkspace("cron");
    await expect(
      service(seeded).create({
        name: "x",
        prompt: "y",
        timezone: "UTC",
        schedule: { kind: "cron", expr: "not a cron" },
      }),
    ).rejects.toBeInstanceOf(AutomatonValidationError);
  });

  it("a false->true enable flip on update recomputes nextDueAt to a future time", async () => {
    const seeded = await seedWorkspace("flip");
    const created = await service(seeded).create({
      name: "x",
      prompt: "y",
      timezone: "UTC",
      schedule: { kind: "daily", hour: 8, minute: 0 },
      enabled: false,
    });
    await env.REGISTRY_DB.prepare("UPDATE automata SET disabled_reason = ? WHERE id = ?")
      .bind("Schedule is invalid.", created.id)
      .run();
    const updated = await service(seeded).update(created.id, { enabled: true });
    expect(updated.enabled).toBe(true);
    expect(updated.disabledReason).toBeNull();
    expect(updated.nextDueAt).toBeGreaterThan(Date.now());
  });

  it("saving a valid schedule clears an existing disabled reason", async () => {
    const seeded = await seedWorkspace("clear_reason");
    const created = await service(seeded).create({
      name: "x",
      prompt: "y",
      timezone: "UTC",
      schedule: { kind: "daily", hour: 8, minute: 0 },
      enabled: false,
    });
    await env.REGISTRY_DB.prepare("UPDATE automata SET disabled_reason = ? WHERE id = ?")
      .bind("Schedule is invalid.", created.id)
      .run();

    const updated = await service(seeded).update(created.id, {
      schedule: { kind: "daily", hour: 9, minute: 30 },
    });

    expect(updated.disabledReason).toBeNull();
    expect(updated.scheduleJson).toBe('{"kind":"daily","hour":9,"minute":30}');
  });

  it("update patches only the provided fields", async () => {
    const seeded = await seedWorkspace("patch");
    const created = await service(seeded).create({
      name: "x",
      prompt: "y",
      timezone: "UTC",
      schedule: { kind: "daily", hour: 8, minute: 0 },
    });
    const updated = await service(seeded).update(created.id, { name: "renamed" });
    expect(updated.name).toBe("renamed");
    expect(updated.prompt).toBe("y");
    expect(updated.nextDueAt).toBe(created.nextDueAt);
  });

  it("get/update on an automaton in another workspace throws NotFound", async () => {
    const a = await seedWorkspace("wsa");
    const b = await seedWorkspace("wsb");
    const created = await service(a).create({
      name: "x",
      prompt: "y",
      timezone: "UTC",
      schedule: { kind: "daily", hour: 8, minute: 0 },
    });
    await expect(service(b).get(created.id)).rejects.toBeInstanceOf(AutomatonNotFoundError);
    await expect(service(b).update(created.id, { name: "z" })).rejects.toBeInstanceOf(
      AutomatonNotFoundError,
    );
  });

  it("create rejects a project that does not belong to the workspace", async () => {
    const seeded = await seedWorkspace("proj");
    await expect(
      service(seeded).create({
        name: "x",
        prompt: "y",
        timezone: "UTC",
        schedule: { kind: "daily", hour: 8, minute: 0 },
        projectId: "prj_does_not_exist",
      }),
    ).rejects.toBeInstanceOf(AutomatonProjectNotFoundError);
  });

  it("create leaves the model null so the run inherits the agent's model", async () => {
    const seeded = await seedWorkspace("model_default");
    const row = await service(seeded).create({
      name: "x",
      prompt: "y",
      timezone: "UTC",
      schedule: { kind: "daily", hour: 8, minute: 0 },
    });
    expect(row.modelProvider).toBeNull();
    expect(row.model).toBeNull();
    expect(row.modelInputModalities).toBeNull();
  });

  it("create persists a model override and defaults its modalities to text", async () => {
    const seeded = await seedWorkspace("model_set");
    const row = await service(seeded).create({
      name: "x",
      prompt: "y",
      timezone: "UTC",
      schedule: { kind: "daily", hour: 8, minute: 0 },
      modelProvider: "mock",
      model: "mock-model",
    });
    expect(row.modelProvider).toBe("mock");
    expect(row.model).toBe("mock-model");
    expect(row.modelInputModalities).toBe('["text"]');
  });

  it("create rejects a provider the workspace has not set up", async () => {
    const seeded = await seedWorkspace("model_unusable");
    await expect(
      service(seeded).create({
        name: "x",
        prompt: "y",
        timezone: "UTC",
        schedule: { kind: "daily", hour: 8, minute: 0 },
        modelProvider: "anthropic",
        model: "claude-opus-4-8",
      }),
    ).rejects.toBeInstanceOf(AutomatonValidationError);
  });

  it("create rejects a provider given without a model", async () => {
    const seeded = await seedWorkspace("model_half");
    await expect(
      service(seeded).create({
        name: "x",
        prompt: "y",
        timezone: "UTC",
        schedule: { kind: "daily", hour: 8, minute: 0 },
        modelProvider: "mock",
      }),
    ).rejects.toBeInstanceOf(AutomatonValidationError);
  });

  it("update sets a model override, and a null clears it back to the agent's model", async () => {
    const seeded = await seedWorkspace("model_patch");
    const created = await service(seeded).create({
      name: "x",
      prompt: "y",
      timezone: "UTC",
      schedule: { kind: "daily", hour: 8, minute: 0 },
    });

    const overridden = await service(seeded).update(created.id, {
      modelProvider: "mock",
      model: "mock-model",
    });
    expect(overridden.modelProvider).toBe("mock");
    expect(overridden.model).toBe("mock-model");

    const cleared = await service(seeded).update(created.id, {
      modelProvider: null,
      model: null,
    });
    expect(cleared.modelProvider).toBeNull();
    expect(cleared.model).toBeNull();
    expect(cleared.modelInputModalities).toBeNull();
  });

  it("update leaves an existing model override alone when the patch omits it", async () => {
    const seeded = await seedWorkspace("model_untouched");
    const created = await service(seeded).create({
      name: "x",
      prompt: "y",
      timezone: "UTC",
      schedule: { kind: "daily", hour: 8, minute: 0 },
      modelProvider: "mock",
      model: "mock-model",
    });
    const renamed = await service(seeded).update(created.id, { name: "renamed" });
    expect(renamed.name).toBe("renamed");
    expect(renamed.modelProvider).toBe("mock");
    expect(renamed.model).toBe("mock-model");
  });

  it("persists an explicit agent override on create", async () => {
    const seeded = await seedWorkspace("wb-create");
    const wb = await seedWorkbench(seeded.workspaceId);
    const row = await service(seeded).create({
      name: "wb",
      prompt: "p",
      timezone: "UTC",
      schedule: { kind: "hourly", minute: 0 },
      workbenchId: wb,
    });
    expect(row.agentId).toBe(wb);
  });

  // `agent_id` is NOT NULL, so "inherit" has no stored representation any more.
  // Omitting the override means the workspace's own agent, which is what the
  // old inherit-at-fire-time degraded to whenever the project had no default.
  it("defaults to the workspace's agent when no override is given", async () => {
    const seeded = await seedWorkspace("wb-null");
    const row = await service(seeded).create({
      name: "wb",
      prompt: "p",
      timezone: "UTC",
      schedule: { kind: "hourly", minute: 0 },
    });
    expect(row.agentId).toBe(seeded.agentId);
  });

  it("resets to the workspace's agent when workbenchId is null on update", async () => {
    const seeded = await seedWorkspace("wb-clear");
    const wb = await seedWorkbench(seeded.workspaceId);
    const created = await service(seeded).create({
      name: "wb",
      prompt: "p",
      timezone: "UTC",
      schedule: { kind: "hourly", minute: 0 },
      workbenchId: wb,
    });
    expect(created.agentId).toBe(wb);
    const updated = await service(seeded).update(created.id, { workbenchId: null });
    expect(updated.agentId).toBe(seeded.agentId);
  });

  // The project-default fallback, at the SAME precedence thread creation uses.
  // `agent_id` is NOT NULL, so nothing can mean "inherit at fire time" any
  // more - the inheritance has to happen here, at write time. Lose it and an
  // automaton created under a project silently runs on the workspace's agent,
  // against a different set of repositories and secrets, with nothing to say so.
  it("falls back to the PROJECT's default agent, not the workspace agent, on create", async () => {
    const seeded = await seedWorkspace("wb-project-default");
    const wbA = await seedWorkbench(seeded.workspaceId);
    const projectId = await seedProject(seeded.workspaceId, wbA);
    const row = await service(seeded).create({
      name: "wb",
      prompt: "p",
      timezone: "UTC",
      schedule: { kind: "hourly", minute: 0 },
      projectId,
    });
    expect(row.agentId).toBe(wbA);
    expect(row.agentId).not.toBe(seeded.agentId);
  });

  it("prefers an explicit agent over the project's default on create", async () => {
    const seeded = await seedWorkspace("wb-explicit-over-default");
    const wbDefault = await seedWorkbench(seeded.workspaceId);
    const wbExplicit = await seedWorkbench(seeded.workspaceId);
    const projectId = await seedProject(seeded.workspaceId, wbDefault);
    const row = await service(seeded).create({
      name: "wb",
      prompt: "p",
      timezone: "UTC",
      schedule: { kind: "hourly", minute: 0 },
      projectId,
      workbenchId: wbExplicit,
    });
    expect(row.agentId).toBe(wbExplicit);
  });

  it("degrades to the workspace agent when the project's default is archived", async () => {
    const seeded = await seedWorkspace("wb-default-archived");
    const wbA = await seedWorkbench(seeded.workspaceId);
    const projectId = await seedProject(seeded.workspaceId, wbA);
    // Archived AFTER being set as the default: the caller never asked for it,
    // so this must degrade rather than 404 the write.
    await new WorkbenchRepository(db()).archive(wbA, now + 1);
    const row = await service(seeded).create({
      name: "wb",
      prompt: "p",
      timezone: "UTC",
      schedule: { kind: "hourly", minute: 0 },
      projectId,
    });
    expect(row.agentId).toBe(seeded.agentId);
  });

  it("resolves a null agent on update against the project the patch leaves behind", async () => {
    const seeded = await seedWorkspace("wb-update-default");
    const wbExplicit = await seedWorkbench(seeded.workspaceId);
    const wbOldDefault = await seedWorkbench(seeded.workspaceId);
    const wbNewDefault = await seedWorkbench(seeded.workspaceId);
    const oldProject = await seedProject(seeded.workspaceId, wbOldDefault);
    const newProject = await seedProject(seeded.workspaceId, wbNewDefault);

    const created = await service(seeded).create({
      name: "wb",
      prompt: "p",
      timezone: "UTC",
      schedule: { kind: "hourly", minute: 0 },
      projectId: oldProject,
      workbenchId: wbExplicit,
    });
    expect(created.agentId).toBe(wbExplicit);

    // Clearing the agent and moving the project in ONE update must land on the
    // NEW project's default, not the old one's and not the workspace agent.
    const updated = await service(seeded).update(created.id, {
      projectId: newProject,
      workbenchId: null,
    });
    expect(updated.agentId).toBe(wbNewDefault);
  });

  it("rejects a dangling agent id", async () => {
    const seeded = await seedWorkspace("wb-bad");
    await expect(
      service(seeded).create({
        name: "wb",
        prompt: "p",
        timezone: "UTC",
        schedule: { kind: "hourly", minute: 0 },
        workbenchId: "wb_does_not_exist",
      }),
    ).rejects.toThrow();
  });

  it("fires against the override agent, not the project default", async () => {
    const seeded = await seedWorkspace("wb-fire");
    const wbA = await seedWorkbench(seeded.workspaceId);
    const wbB = await seedWorkbench(seeded.workspaceId);
    const projectId = await seedProject(seeded.workspaceId, wbA); // default = A
    const created = await service(seeded).create({
      name: "wb",
      prompt: "p",
      timezone: "UTC",
      schedule: { kind: "hourly", minute: 0 },
      projectId,
      workbenchId: wbB,
    });
    const automaton = await new AutomatonRepository(db()).getById(created.id);
    const { threadId } = await startAutomatonRun(env, db(), automaton!, {
      trigger: "manual",
      dueAt: null,
    });
    const thread = await db()
      .select()
      .from(schema.threadIndex)
      .where(eq(schema.threadIndex.id, threadId))
      .get();
    expect(thread!.agentId).toBe(wbB);
  });

  // The project default is NO LONGER consulted at fire time: the automaton's
  // own agent is authoritative, and the migration resolved the one-time
  // inheritance into `agent_id` itself. An unattended run must not move onto a
  // different agent's repositories because someone edited the project.
  // The project default is resolved ONCE, when the automaton is written, and is
  // NOT consulted again at fire time. Both halves matter: the run must land on
  // the default the automaton was created under, and a later edit to the
  // project must not silently move an unattended run onto different
  // repositories and secrets.
  it("fires against the project default it was created under, frozen at write time", async () => {
    const seeded = await seedWorkspace("wb-fire-inherit");
    const wbA = await seedWorkbench(seeded.workspaceId);
    const wbLater = await seedWorkbench(seeded.workspaceId);
    const projectId = await seedProject(seeded.workspaceId, wbA);
    const created = await service(seeded).create({
      name: "wb",
      prompt: "p",
      timezone: "UTC",
      schedule: { kind: "hourly", minute: 0 },
      projectId,
    });
    expect(created.agentId).toBe(wbA);

    // Move the project's default AFTER the automaton exists.
    await db()
      .update(schema.projects)
      .set({ defaultAgentId: wbLater })
      .where(eq(schema.projects.id, projectId));

    const automaton = await new AutomatonRepository(db()).getById(created.id);
    const { threadId } = await startAutomatonRun(env, db(), automaton!, {
      trigger: "manual",
      dueAt: null,
    });
    const thread = await db()
      .select()
      .from(schema.threadIndex)
      .where(eq(schema.threadIndex.id, threadId))
      .get();
    expect(thread!.agentId).toBe(wbA);
  });

  it("creates a once automaton with nextDueAt equal to runAt", async () => {
    const seeded = await seedWorkspace("once-create");
    const runAt = now + 86_400_000;
    const row = await service(seeded).create({
      name: "once",
      prompt: "p",
      timezone: "UTC",
      schedule: { kind: "once", runAt },
    });
    expect(row.nextDueAt).toBe(runAt);
    expect(JSON.parse(row.scheduleJson)).toEqual({ kind: "once", runAt });
  });

  it("rejects re-enabling a once automaton whose runAt is past", async () => {
    const seeded = await seedWorkspace("once-reenable");
    const runAt = Date.now() - 60_000;
    const created = await service(seeded).create({
      name: "once",
      prompt: "p",
      timezone: "UTC",
      schedule: { kind: "once", runAt: Date.now() + 86_400_000 },
    });
    await db()
      .update(schema.automata)
      .set({
        scheduleJson: JSON.stringify({ kind: "once", runAt }),
        enabled: false,
        nextDueAt: null,
      })
      .where(eq(schema.automata.id, created.id));

    await expect(service(seeded).update(created.id, { enabled: true })).rejects.toThrow(
      "Pick a new time before enabling.",
    );
  });
});
