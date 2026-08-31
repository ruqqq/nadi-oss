import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../../src/db/schema";
import { applyRegistryTestSchema } from "./helpers/registry";
import { createAutomatonManagementTools } from "../../src/agent/automaton-tools";

const now = 1_800_000_000_000;
const threadId = "th_tools";
function db() {
  return drizzle(env.REGISTRY_DB, { schema });
}

async function seed() {
  const workspaceId = "ws_tools";
  const ownerUserId = "user_tools";
  const agentId = "agt_tools";
  await db()
    .insert(schema.users)
    .values({
      id: ownerUserId,
      email: "tools@example.com",
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
  await db().insert(schema.threadIndex).values({
    id: threadId,
    workspaceId,
    agentId,
    projectId: null,
    title: "Test thread",
    runtime: "think",
    source: "manual",
    createdAt: now,
    updatedAt: now,
  });
  return { workspaceId, ownerUserId, agentId };
}

// Tools return their result object directly; the AI SDK passes a second
// ToolCallOptions arg we don't need here.
function run(t: unknown, args: unknown) {
  return (t as { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute(
    args,
    {} as never,
  );
}

describe("automaton management tools (integration)", () => {
  beforeEach(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  it("create_automaton persists a row with the workspace owner and the thread's agent", async () => {
    const seeded = await seed();
    const tools = createAutomatonManagementTools({ env: env as never, threadId });
    const result = (await run(tools.create_automaton, {
      name: "Daily briefing",
      prompt: "Summarize today.",
      timezone: "UTC",
      schedule: { kind: "daily", hour: 8, minute: 0 },
    })) as { ok: boolean; automaton: { id: string } };

    expect(result.ok).toBe(true);
    const row = await db()
      .select()
      .from(schema.automata)
      .where(eq(schema.automata.id, result.automaton.id))
      .get();
    expect(row?.workspaceId).toBe(seeded.workspaceId);
    expect(row?.ownerUserId).toBe(seeded.ownerUserId);
    expect(row?.agentId).toBe(seeded.agentId);
  });

  it("list_automata and get_automaton round-trip a created automaton", async () => {
    await seed();
    const tools = createAutomatonManagementTools({ env: env as never, threadId });
    const created = (await run(tools.create_automaton, {
      name: "Weekly",
      prompt: "Do the weekly pass.",
      timezone: "UTC",
      schedule: { kind: "weekly", weekday: 1, hour: 9, minute: 0 },
    })) as { automaton: { id: string } };

    const listed = (await run(tools.list_automata, {})) as {
      automata: { id: string; schedule: string }[];
    };
    expect(listed.automata.map((a) => a.id)).toContain(created.automaton.id);
    expect(listed.automata[0]!.schedule).toContain("Monday");

    const got = (await run(tools.get_automaton, { id: created.automaton.id })) as {
      ok: boolean;
      automaton: { id: string };
    };
    expect(got.ok).toBe(true);
    expect(got.automaton.id).toBe(created.automaton.id);
  });

  it("update_automaton disables via enabled:false and re-enables with a fresh nextDueAt", async () => {
    await seed();
    const tools = createAutomatonManagementTools({ env: env as never, threadId });
    const created = (await run(tools.create_automaton, {
      name: "Toggle",
      prompt: "x",
      timezone: "UTC",
      schedule: { kind: "daily", hour: 8, minute: 0 },
    })) as { automaton: { id: string } };

    const disabled = (await run(tools.update_automaton, {
      id: created.automaton.id,
      enabled: false,
    })) as { automaton: { enabled: boolean } };
    expect(disabled.automaton.enabled).toBe(false);

    const enabled = (await run(tools.update_automaton, {
      id: created.automaton.id,
      enabled: true,
    })) as { automaton: { enabled: boolean; nextDueAt: number } };
    expect(enabled.automaton.enabled).toBe(true);
    expect(enabled.automaton.nextDueAt).toBeGreaterThan(Date.now());
  });

  it("create_automaton surfaces a readable error for a bad timezone", async () => {
    await seed();
    const tools = createAutomatonManagementTools({ env: env as never, threadId });
    const result = (await run(tools.create_automaton, {
      name: "x",
      prompt: "y",
      timezone: "Not/A_Zone",
      schedule: { kind: "daily", hour: 8, minute: 0 },
    })) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Not/A_Zone");
  });

  async function seedWorkbench(workspaceId: string, id: string, name: string, description: string) {
    await db().insert(schema.agents).values({
      id,
      workspaceId,
      name,
      // An environment IS an agent now.
      systemPrompt: "You are Nadi.",
      provider: "mock",
      model: "mock",
      description,
      setupScript: "",
      sandboxEnvVarsJson: "{}",
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  it("list_workbenches returns the workspace's active agents", async () => {
    const seeded = await seed();
    await seedWorkbench(seeded.workspaceId, "wbk_tools", "Backend", "the backend bench");
    const tools = createAutomatonManagementTools({ env: env as never, threadId });

    const result = (await run(tools.list_workbenches, {})) as {
      ok: boolean;
      workbenches: { id: string; name: string; description: string }[];
    };

    expect(result.ok).toBe(true);
    expect(result.workbenches).toContainEqual({
      id: "wbk_tools",
      name: "Backend",
      description: "the backend bench",
    });
  });

  it("create_automaton persists an agent override", async () => {
    const seeded = await seed();
    await seedWorkbench(seeded.workspaceId, "wbk_override", "Override", "");
    const tools = createAutomatonManagementTools({ env: env as never, threadId });

    const result = (await run(tools.create_automaton, {
      name: "With bench",
      prompt: "go",
      timezone: "UTC",
      schedule: { kind: "daily", hour: 8, minute: 0 },
      workbenchId: "wbk_override",
    })) as { ok: boolean; automaton: { id: string } };

    expect(result.ok).toBe(true);
    const row = await db()
      .select()
      .from(schema.automata)
      .where(eq(schema.automata.id, result.automaton.id))
      .get();
    expect(row?.agentId).toBe("wbk_override");
  });
});
