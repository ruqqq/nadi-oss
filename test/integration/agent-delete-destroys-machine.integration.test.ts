/**
 * DISABLE, THEN DELETE — the ordinary way people remove an agent, and the way
 * that destroyed nothing.
 *
 * The deletion teardown opens the thread's sandbox through the normal compute
 * resolve. That resolve now (correctly) withholds compute from a DISABLED or
 * ARCHIVED agent — so the teardown, running on exactly such an agent, resolved
 * to `null`, tore down nothing, and returned `compute_disabled`. The sprite
 * survived to its idle TTL while the confirm dialog said "Its files are
 * destroyed." A sprite that nothing deletes bills forever.
 *
 * So this test refuses to mock `shutdownComputeForAgentDeletion` — mocking it
 * is exactly why the fan-out test in `agent-routes.integration.test.ts` could
 * not see this. It acquires a REAL runtime on the `mock` provider (a real,
 * deployment-selectable backend), turns the agent off through the real PATCH
 * route, deletes it through the real archive route, and reads the machine's
 * state out of the `AgentSandbox` DO that owns it.
 */
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ToolSet } from "ai";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import type { ThinkThreadAgent } from "../../src/agent/think-thread-agent";
import type { AgentSandbox } from "../../src/compute/agent-sandbox-do";
import { applyRegistryTestSchema } from "./helpers/registry";

const now = 1_800_000_000_000;

type TestableAgent = ThinkThreadAgent & {
  __unsafe_ensureInitialized(): Promise<void>;
  computeToolsForTest(): Promise<ToolSet>;
};

function cookie(token: string) {
  return { cookie: `better-auth.session_token=${token}` };
}

/** The machine's own status, read from the DO that owns it. `null` = no row. */
function computeStatus(storage: DurableObjectStorage): string | null {
  const tables = storage.sql
    .exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'compute_state'",
    )
    .toArray();
  if (tables.length === 0) return null;
  const rows = storage.sql.exec<{ status: string }>("SELECT status FROM compute_state").toArray();
  return rows[0]?.status ?? null;
}

function storageOf(instance: { ctx: { storage: DurableObjectStorage } }): DurableObjectStorage {
  return instance.ctx.storage;
}

async function readComputeStatus(threadId: string): Promise<string | null> {
  // `idFromName` for AGENT_SANDBOX — a plain DO with no onStart to bypass.
  const stub = env.AGENT_SANDBOX.get(env.AGENT_SANDBOX.idFromName(threadId));
  return runInDurableObject(stub, (instance: AgentSandbox) =>
    computeStatus(storageOf(instance as unknown as { ctx: { storage: DurableObjectStorage } })),
  );
}

async function clearRegistry() {
  const db = drizzle(env.REGISTRY_DB, { schema });
  await db.delete(schema.workspaceSandboxSettings);
  await db.delete(schema.threadIndex);
  await db.delete(schema.agents);
  await db.delete(schema.workspaceMembers);
  await db.delete(schema.workspaces);
  await db.delete(schema.sessions);
  await db.delete(schema.users);
}

/**
 * A workspace with compute ON, a member session, TWO agents (the last-agent
 * guard refuses deleting the only one), and a thread on the doomed agent.
 */
async function seedWorkspaceWithLiveThread(suffix: string) {
  const db = drizzle(env.REGISTRY_DB, { schema });
  const userId = `user-${suffix}`;
  const token = `token-${suffix}`;
  const workspaceId = `workspace-${suffix}`;
  const doomedAgentId = `agent-doomed-${suffix}`;
  const threadId = `thr-${suffix}`;

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
    expiresAt: new Date(now + 3_600_000),
    createdAt: new Date(now),
    updatedAt: new Date(now),
    ipAddress: null,
    userAgent: null,
  });
  await db.insert(schema.workspaces).values({ id: workspaceId, name: workspaceId, createdAt: now });
  await db
    .insert(schema.workspaceMembers)
    .values({ workspaceId, userId, role: "owner", createdAt: now });
  await db.insert(schema.agents).values([
    {
      id: `agent-keeper-${suffix}`,
      workspaceId,
      name: "Keeper",
      systemPrompt: "You are Nadi.",
      provider: "mock",
      model: "mock",
      createdAt: now,
    },
    {
      id: doomedAgentId,
      workspaceId,
      name: "Doomed",
      systemPrompt: "You are Nadi.",
      provider: "mock",
      model: "mock",
      createdAt: now + 1,
    },
  ]);
  await db.insert(schema.threadIndex).values({
    id: threadId,
    workspaceId,
    agentId: doomedAgentId,
    title: "live",
    runtime: "think",
    source: "manual",
    lastMessagePreview: "",
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  });

  await env.REGISTRY_DB.prepare(
    `INSERT INTO workspace_sandbox_settings
      (workspace_id, enabled, provider, provider_config_json,
       image, idle_timeout_ms, recovery_ttl_ms, max_process_runtime_ms, limits_json,
       network_restriction_enabled, network_domain_allowlist)
     VALUES (?, 1, 'mock', ?, '', 900000, 86400000, 600000, '{}', 0, '')`,
  )
    .bind(workspaceId, JSON.stringify({ kind: "mock" }))
    .run();

  return { userId, token, workspaceId, doomedAgentId, threadId };
}

/** Runs a real command through the model-facing tool, acquiring a real runtime. */
async function acquireMachine(threadId: string) {
  const stub = env.THINK_THREAD_AGENT.get(env.THINK_THREAD_AGENT.idFromName(threadId));
  await runInDurableObject(stub, async (instance: ThinkThreadAgent) => {
    const testable = instance as TestableAgent;
    await testable.__unsafe_ensureInitialized();
    const tools = await testable.computeToolsForTest();
    expect(tools.exec, "compute must be enabled before the agent is disabled").toBeDefined();
    await tools.exec!.execute!({ command: "echo alive" }, {} as never);
  });
}

describe("deleting an agent destroys its machine", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  beforeEach(async () => {
    await clearRegistry();
  });

  it("even when the user turned the agent OFF before deleting it", async () => {
    const seeded = await seedWorkspaceWithLiveThread("disable-then-delete");
    await acquireMachine(seeded.threadId);
    expect(await readComputeStatus(seeded.threadId)).toBe("active");

    // Step one of the ordinary flow: stop it. Through the real route, so the
    // column that is written is the one the compute path reads.
    const disable = await SELF.fetch(`https://nadi.test/api/agents/${seeded.doomedAgentId}`, {
      method: "PATCH",
      headers: { ...cookie(seeded.token), "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(disable.status).toBe(200);
    // The machine is still there — "Its machine and files are kept" is what
    // disable promises, and it is what makes the next step matter.
    expect(await readComputeStatus(seeded.threadId)).toBe("active");

    // Step two: remove it.
    const del = await SELF.fetch(`https://nadi.test/api/agents/${seeded.doomedAgentId}/archive`, {
      method: "POST",
      headers: cookie(seeded.token),
    });
    expect(del.status).toBe(200);

    expect(
      await readComputeStatus(seeded.threadId),
      "the machine of a DISABLED agent must still be destroyed when the agent is deleted — " +
        "a sprite nothing deletes bills until its idle TTL, while the dialog says its files are destroyed",
    ).toBe("absent");

    const row = await drizzle(env.REGISTRY_DB, { schema })
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.id, seeded.doomedAgentId))
      .get();
    expect(row?.archivedAt).toEqual(expect.any(Number));
  });

  it("and when the agent was never disabled", async () => {
    const seeded = await seedWorkspaceWithLiveThread("delete-while-enabled");
    await acquireMachine(seeded.threadId);
    expect(await readComputeStatus(seeded.threadId)).toBe("active");

    const del = await SELF.fetch(`https://nadi.test/api/agents/${seeded.doomedAgentId}/archive`, {
      method: "POST",
      headers: cookie(seeded.token),
    });
    expect(del.status).toBe(200);

    expect(await readComputeStatus(seeded.threadId)).toBe("absent");
  });
});
