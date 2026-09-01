import { SELF, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import type { Env } from "../../src/env";
import * as schema from "../../src/db/schema";
import { ComputeEnvSecretsStore } from "../../src/compute/env-secrets";
import { createWorkspaceSecretsServices } from "../../src/secrets";
import { applyRegistryTestSchema } from "./helpers/registry";
import { AgentSandbox } from "../../src/compute/agent-sandbox-do";

const now = 1_800_000_000_000;

function cookie(token: string) {
  return { cookie: `better-auth.session_token=${token}` };
}

async function clearSecretsKv() {
  const kv = (env as unknown as Env).SECRETS_KV;
  const page = await kv.list();
  await Promise.all(page.keys.map((key) => kv.delete(key.name)));
}

async function clearRegistry() {
  const db = drizzle(env.REGISTRY_DB, { schema });
  await db.delete(schema.agentSecretNames);
  await db.delete(schema.agentRepositories);
  // Both FK `agents`, so they must go before it — and the delete tests below
  // seed them.
  await db.delete(schema.agentMemories);
  await db.delete(schema.skills);
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
  const userId = input?.userId ?? "user-agent-routes";
  const token = input?.token ?? "agent-routes-token";

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
  memberCreatedAt?: number;
  agentCreatedAt?: number;
}) {
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
  memberCreatedAt?: number;
  agentCreatedAt?: number;
}) {
  const userId = input?.userId ?? "user-agent-routes";
  const token = input?.token ?? "agent-routes-token";
  const workspaceId = input?.workspaceId ?? "workspace-agent-routes";

  await insertUserSession({ userId, token });
  const workspace = await insertWorkspaceMembership({
    userId,
    workspaceId,
    ...(input?.memberCreatedAt !== undefined ? { memberCreatedAt: input.memberCreatedAt } : {}),
    ...(input?.agentCreatedAt !== undefined ? { agentCreatedAt: input.agentCreatedAt } : {}),
  });

  return { userId, token, workspaceId: workspace.workspaceId, agentId: workspace.agentId };
}

describe("agent routes", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  beforeEach(async () => {
    await clearRegistry();
    await clearSecretsKv();
  });

  afterEach(async () => {
    await clearRegistry();
    await clearSecretsKv();
  });

  it("supports agent CRUD, repo-set, env-vars, secrets, and archive", async () => {
    const seeded = await seedUserWorkspace();

    const createRes = await SELF.fetch("https://nadi.test/api/agents", {
      method: "POST",
      headers: { ...cookie(seeded.token), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "  staging  ", description: "Staging env" }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      agent: { id: string; name: string; description: string };
    };
    expect(created.agent).toMatchObject({
      id: expect.any(String),
      name: "staging",
      description: "Staging env",
      archivedAt: null,
    });
    const agentId = created.agent.id;

    const listRes = await SELF.fetch("https://nadi.test/api/agents?status=all", {
      headers: cookie(seeded.token),
    });
    expect(listRes.status).toBe(200);
    const listed = (await listRes.json()) as { agents: Array<{ id: string }> };
    expect(listed.agents.some((w) => w.id === agentId)).toBe(true);

    const patchRes = await SELF.fetch(`https://nadi.test/api/agents/${agentId}`, {
      method: "PATCH",
      headers: { ...cookie(seeded.token), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "  staging-renamed  " }),
    });
    expect(patchRes.status).toBe(200);
    await expect(patchRes.json()).resolves.toEqual({
      agent: expect.objectContaining({ id: agentId, name: "staging-renamed" }),
    });

    const repoEntry = {
      source: "github",
      name: "repo-agent-routes",
      url: "https://github.com/acme/repo-agent-routes.git",
      checkoutPathName: "repo-agent-routes",
      defaultBranch: "main",
      rootDirectory: "",
      setupCommand: "",
      packageManager: "",
      sourceInstallationId: null,
      githubRepoId: null,
    };

    const putReposRes = await SELF.fetch(`https://nadi.test/api/agents/${agentId}/repositories`, {
      method: "PUT",
      headers: { ...cookie(seeded.token), "Content-Type": "application/json" },
      body: JSON.stringify([repoEntry]),
    });
    expect(putReposRes.status).toBe(200);

    const getAfterRepos = await SELF.fetch(`https://nadi.test/api/agents/${agentId}`, {
      headers: cookie(seeded.token),
    });
    expect(getAfterRepos.status).toBe(200);
    const afterRepos = (await getAfterRepos.json()) as {
      agent: { repositories: Array<{ name: string; url: string; source: string }> };
    };
    expect(afterRepos.agent.repositories).toHaveLength(1);
    expect(afterRepos.agent.repositories[0]).toMatchObject({
      name: "repo-agent-routes",
      url: "https://github.com/acme/repo-agent-routes.git",
      source: "github",
    });

    const putEnvVarsRes = await SELF.fetch(`https://nadi.test/api/agents/${agentId}/env-vars`, {
      method: "PUT",
      headers: { ...cookie(seeded.token), "Content-Type": "application/json" },
      body: JSON.stringify({ envVars: { NODE_ENV: "staging" } }),
    });
    expect(putEnvVarsRes.status).toBe(200);

    const getAfterEnvVars = await SELF.fetch(`https://nadi.test/api/agents/${agentId}`, {
      headers: cookie(seeded.token),
    });
    const afterEnvVars = (await getAfterEnvVars.json()) as {
      agent: { envVars: Record<string, string> };
    };
    expect(afterEnvVars.agent.envVars).toEqual({ NODE_ENV: "staging" });

    const putSecretRes = await SELF.fetch(
      `https://nadi.test/api/agents/${agentId}/secrets/GH_TOKEN`,
      {
        method: "PUT",
        headers: { ...cookie(seeded.token), "Content-Type": "application/json" },
        body: JSON.stringify({ value: "secret-value" }),
      },
    );
    expect(putSecretRes.status).toBe(200);

    const getAfterSecret = await SELF.fetch(`https://nadi.test/api/agents/${agentId}`, {
      headers: cookie(seeded.token),
    });
    const afterSecretBody = await getAfterSecret.text();
    expect(afterSecretBody).not.toContain("secret-value");
    const afterSecret = JSON.parse(afterSecretBody) as {
      agent: { secretEnvNames: string[] };
    };
    expect(afterSecret.agent.secretEnvNames).toEqual(["GH_TOKEN"]);

    const deleteSecretRes = await SELF.fetch(
      `https://nadi.test/api/agents/${agentId}/secrets/GH_TOKEN`,
      { method: "DELETE", headers: cookie(seeded.token) },
    );
    expect(deleteSecretRes.status).toBe(200);

    const getAfterDelete = await SELF.fetch(`https://nadi.test/api/agents/${agentId}`, {
      headers: cookie(seeded.token),
    });
    const afterDelete = (await getAfterDelete.json()) as {
      agent: { secretEnvNames: string[] };
    };
    expect(afterDelete.agent.secretEnvNames).toEqual([]);

    const archiveRes = await SELF.fetch(`https://nadi.test/api/agents/${agentId}/archive`, {
      method: "POST",
      headers: cookie(seeded.token),
    });
    expect(archiveRes.status).toBe(200);
    await expect(archiveRes.json()).resolves.toEqual({
      agent: expect.objectContaining({ id: agentId, archivedAt: expect.any(Number) }),
    });

    const listActiveRes = await SELF.fetch("https://nadi.test/api/agents", {
      headers: cookie(seeded.token),
    });
    const listActive = (await listActiveRes.json()) as { agents: Array<{ id: string }> };
    expect(listActive.agents.some((w) => w.id === agentId)).toBe(false);
  });

  describe("secret names come from the D1 index, not the KV list", () => {
    function secretStore() {
      return new ComputeEnvSecretsStore(createWorkspaceSecretsServices(env as unknown as Env));
    }

    async function insertAgentRow(input: {
      id: string;
      workspaceId: string;
      secretNamesBackfilled: boolean;
    }) {
      const db = drizzle(env.REGISTRY_DB, { schema });
      await db.insert(schema.agents).values({
        id: input.id,
        workspaceId: input.workspaceId,
        name: "Legacy Agent",
        // An environment IS an agent now.
        systemPrompt: "You are Nadi.",
        provider: "mock",
        model: "mock",
        secretNamesBackfilled: input.secretNamesBackfilled,
        createdAt: now,
        updatedAt: now,
      });
    }

    async function getSecretNames(id: string, token: string): Promise<string[]> {
      const res = await SELF.fetch(`https://nadi.test/api/agents/${id}`, {
        headers: cookie(token),
      });
      const body = (await res.json()) as { agent: { secretEnvNames: string[] } };
      return body.agent.secretEnvNames;
    }

    it("seeds the D1 index from pre-existing KV secrets on first read, then flips the flag", async () => {
      const seeded = await seedUserWorkspace();
      const agentId = "env_legacy_backfill";
      // An agent predating the D1 index: KV holds the secret, D1 does not.
      await insertAgentRow({
        id: agentId,
        workspaceId: seeded.workspaceId,
        secretNamesBackfilled: false,
      });
      await secretStore().setAgent(seeded.workspaceId, agentId, "LEGACY_KEY", "v1");

      // First read backfills from the KV list and returns the name.
      expect(await getSecretNames(agentId, seeded.token)).toEqual(["LEGACY_KEY"]);

      const db = drizzle(env.REGISTRY_DB, { schema });
      const names = await db
        .select({ name: schema.agentSecretNames.name })
        .from(schema.agentSecretNames)
        .all();
      expect(names.map((n) => n.name)).toEqual(["LEGACY_KEY"]);
      const seededAgent = await db
        .select()
        .from(schema.agents)
        .where(eq(schema.agents.id, agentId))
        .get();
      expect(seededAgent?.secretNamesBackfilled).toBe(true);
    });

    it("keeps a secret name listed even after its KV value is gone (D1 is authoritative)", async () => {
      const seeded = await seedUserWorkspace();
      const createRes = await SELF.fetch("https://nadi.test/api/agents", {
        method: "POST",
        headers: { ...cookie(seeded.token), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "WB" }),
      });
      const agentId = ((await createRes.json()) as { agent: { id: string } }).agent.id;

      await SELF.fetch(`https://nadi.test/api/agents/${agentId}/secrets/FOO`, {
        method: "PUT",
        headers: { ...cookie(seeded.token), "Content-Type": "application/json" },
        body: JSON.stringify({ value: "bar" }),
      });
      expect(await getSecretNames(agentId, seeded.token)).toEqual(["FOO"]);

      // Drop the KV value out from under the route. Under the old code the name
      // came from the KV list and would vanish; the D1 index keeps it.
      await secretStore().deleteAgent(seeded.workspaceId, agentId, "FOO");
      expect(await getSecretNames(agentId, seeded.token)).toEqual(["FOO"]);
    });

    it("deletes a name on a legacy agent without the stale KV list re-adding it", async () => {
      const seeded = await seedUserWorkspace();
      const agentId = "env_legacy_delete";
      await insertAgentRow({
        id: agentId,
        workspaceId: seeded.workspaceId,
        secretNamesBackfilled: false,
      });
      await secretStore().setAgent(seeded.workspaceId, agentId, "OLD", "v1");

      const res = await SELF.fetch(`https://nadi.test/api/agents/${agentId}/secrets/OLD`, {
        method: "DELETE",
        headers: cookie(seeded.token),
      });
      expect(res.status).toBe(200);
      expect(await getSecretNames(agentId, seeded.token)).toEqual([]);
    });

    it("persists every name when secrets are added concurrently", async () => {
      const seeded = await seedUserWorkspace();
      const createRes = await SELF.fetch("https://nadi.test/api/agents", {
        method: "POST",
        headers: { ...cookie(seeded.token), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "WB" }),
      });
      const agentId = ((await createRes.json()) as { agent: { id: string } }).agent.id;

      const names = ["ALPHA", "BRAVO", "CHARLIE", "DELTA"];
      await Promise.all(
        names.map((name) =>
          SELF.fetch(`https://nadi.test/api/agents/${agentId}/secrets/${name}`, {
            method: "PUT",
            headers: { ...cookie(seeded.token), "Content-Type": "application/json" },
            body: JSON.stringify({ value: `v-${name}` }),
          }),
        ),
      );

      expect(await getSecretNames(agentId, seeded.token)).toEqual(names);
    });
  });

  describe("resourceProfile", () => {
    let token = "";

    beforeEach(async () => {
      const seeded = await seedUserWorkspace();
      token = seeded.token;
    });

    async function createAgentRow(body: Record<string, unknown>) {
      const res = await SELF.fetch("https://nadi.test/api/agents", {
        method: "POST",
        headers: { ...cookie(token), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as {
        agent: { id: string; name: string; resourceProfile: string };
      };
      return json.agent;
    }

    async function patchAgentRaw(id: string, body: Record<string, unknown>) {
      return SELF.fetch(`https://nadi.test/api/agents/${id}`, {
        method: "PATCH",
        headers: { ...cookie(token), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    async function patchAgentRow(id: string, body: Record<string, unknown>) {
      const res = await patchAgentRaw(id, body);
      const json = (await res.json()) as { agent: { id: string; resourceProfile: string } };
      return json.agent;
    }

    it("defaults resourceProfile to small and round-trips an update", async () => {
      const created = await createAgentRow({ name: "Heavy" });
      expect(created.resourceProfile).toBe("small");

      const patched = await patchAgentRow(created.id, { resourceProfile: "medium" });
      expect(patched.resourceProfile).toBe("medium");
    });

    it("rejects an unknown resourceProfile", async () => {
      const created = await createAgentRow({ name: "Bad" });
      const originalName = created.name;

      const res = await patchAgentRaw(created.id, {
        name: "Still valid",
        resourceProfile: "enormous",
      });
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toContain("Invalid resourceProfile");

      // Verify the agent was not mutated
      const getRes = await SELF.fetch(`https://nadi.test/api/agents/${created.id}`, {
        headers: cookie(token),
      });
      const fetched = (await getRes.json()) as { agent: { name: string } };
      expect(fetched.agent.name).toBe(originalName);
    });
  });

  // A workspace with no active, enabled agent cannot start a thread at all, so
  // the last usable one is refused rather than allowed and later diagnosed as a
  // broken workspace.
  describe("the last usable agent", () => {
    it("cannot be disabled", async () => {
      const seeded = await seedUserWorkspace();

      const res = await SELF.fetch(`https://nadi.test/api/agents/${seeded.agentId}`, {
        method: "PATCH",
        headers: { ...cookie(seeded.token), "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      expect(res.status).toBe(409);
      expect(await res.text()).toContain("only agent");

      const after = await SELF.fetch(`https://nadi.test/api/agents/${seeded.agentId}`, {
        headers: cookie(seeded.token),
      });
      expect(((await after.json()) as { agent: { enabled: boolean } }).agent.enabled).toBe(true);
    });

    it("cannot be deleted", async () => {
      const seeded = await seedUserWorkspace();

      const res = await SELF.fetch(`https://nadi.test/api/agents/${seeded.agentId}/archive`, {
        method: "POST",
        headers: cookie(seeded.token),
      });
      expect(res.status).toBe(409);
      expect(await res.text()).toContain("only agent");
    });

    // The guard counts USABLE agents, not rows: a second agent that is already
    // disabled still leaves this one the last one that can do work. Counting
    // rows would let a workspace switch its way to zero.
    it("counts only enabled agents, not archived or disabled ones", async () => {
      const seeded = await seedUserWorkspace();

      const createRes = await SELF.fetch("https://nadi.test/api/agents", {
        method: "POST",
        headers: { ...cookie(seeded.token), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "second" }),
      });
      expect(createRes.status).toBe(201);
      const second = ((await createRes.json()) as { agent: { id: string } }).agent;

      // With two enabled agents, disabling the second is allowed.
      const disableSecond = await SELF.fetch(`https://nadi.test/api/agents/${second.id}`, {
        method: "PATCH",
        headers: { ...cookie(seeded.token), "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      expect(disableSecond.status).toBe(200);

      // Now the first is the last USABLE one, even though two rows exist.
      const disableFirst = await SELF.fetch(`https://nadi.test/api/agents/${seeded.agentId}`, {
        method: "PATCH",
        headers: { ...cookie(seeded.token), "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      expect(disableFirst.status).toBe(409);
    });
  });

  it("saves an agent's instructions, model and reasoning", async () => {
    const seeded = await seedUserWorkspace();

    const res = await SELF.fetch(`https://nadi.test/api/agents/${seeded.agentId}`, {
      method: "PATCH",
      headers: { ...cookie(seeded.token), "Content-Type": "application/json" },
      body: JSON.stringify({
        systemPrompt: "  Be terse.  ",
        model: "some-model",
        reasoningEffort: "high",
        modelSupportsReasoning: true,
      }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { agent: Record<string, unknown> }).agent).toMatchObject({
      systemPrompt: "Be terse.",
      model: "some-model",
      reasoningEffort: "high",
      modelSupportsReasoning: true,
    });
  });

  it("rejects an empty system prompt rather than storing one", async () => {
    const seeded = await seedUserWorkspace();

    const res = await SELF.fetch(`https://nadi.test/api/agents/${seeded.agentId}`, {
      method: "PATCH",
      headers: { ...cookie(seeded.token), "Content-Type": "application/json" },
      body: JSON.stringify({ systemPrompt: "   " }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for a non-member accessing an agent", async () => {
    const owner = await seedUserWorkspace();
    const outsider = await seedUserWorkspace({
      userId: "agent-outsider-user",
      token: "agent-outsider-token",
      workspaceId: "workspace-agent-outsider",
      memberCreatedAt: now + 1,
      agentCreatedAt: now + 1,
    });

    const createRes = await SELF.fetch("https://nadi.test/api/agents", {
      method: "POST",
      headers: { ...cookie(owner.token), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "owner-agent" }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { agent: { id: string } };

    const res = await SELF.fetch(`https://nadi.test/api/agents/${created.agent.id}`, {
      headers: cookie(outsider.token),
    });
    expect(res.status).toBe(404);
  });

  // "Delete this agent and its machine. Its files are destroyed. Threads it ran
  // stay readable." Before this, delete only stamped `archived_at`: no teardown,
  // nothing in the compute path gated on it, and the agent's memories and
  // private skills stayed live.
  describe("delete", () => {
    async function seedSecondAgent(workspaceId: string, id: string) {
      await drizzle(env.REGISTRY_DB, { schema })
        .insert(schema.agents)
        .values({
          id,
          workspaceId,
          name: id,
          systemPrompt: "You are Nadi.",
          provider: "mock",
          model: "mock",
          createdAt: now + 1,
        });
      return id;
    }

    it("archives the agent's memories and PRIVATE skills, and leaves the library's alone", async () => {
      const seeded = await seedUserWorkspace({
        userId: "user-agent-delete-knowledge",
        token: "agent-delete-knowledge-token",
        workspaceId: "workspace-agent-delete-knowledge",
      });
      const doomed = await seedSecondAgent(seeded.workspaceId, "agent-doomed");
      const db = drizzle(env.REGISTRY_DB, { schema });
      await db.insert(schema.agentMemories).values([
        {
          id: "mem-doomed",
          workspaceId: seeded.workspaceId,
          agentId: doomed,
          content: "remember this",
          kind: "fact",
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "mem-survivor",
          workspaceId: seeded.workspaceId,
          agentId: seeded.agentId,
          content: "not mine to lose",
          kind: "fact",
          createdAt: now,
          updatedAt: now,
        },
      ]);
      await db.insert(schema.skills).values([
        {
          id: "skill-private",
          workspaceId: seeded.workspaceId,
          agentId: doomed,
          name: "private-skill",
          description: "d",
          body: "b",
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "skill-library",
          workspaceId: seeded.workspaceId,
          agentId: null,
          name: "library-skill",
          description: "d",
          body: "b",
          createdAt: now,
          updatedAt: now,
        },
      ]);

      const res = await SELF.fetch(`https://nadi.test/api/agents/${doomed}/archive`, {
        method: "POST",
        headers: cookie(seeded.token),
      });
      expect(res.status).toBe(200);

      const memories = await db.select().from(schema.agentMemories).all();
      expect(Object.fromEntries(memories.map((row) => [row.id, row.archivedAt !== null]))).toEqual({
        "mem-doomed": true,
        "mem-survivor": false,
      });

      const skillRows = await db.select().from(schema.skills).all();
      expect(Object.fromEntries(skillRows.map((row) => [row.id, row.archivedAt !== null]))).toEqual(
        { "skill-private": true, "skill-library": false },
      );
    });

    // P3: ONE call to ONE DO, addressed by AGENT id. The route used to walk
    // the agent's non-archived threads and shut each one's sandbox down — N
    // attempts at the same shared machine, and NOTHING AT ALL for an agent
    // whose threads had all been archived, whose sprite was then left billing
    // with nothing able to reach it.
    it("destroys the AGENT's box once, even with no live threads at all", async () => {
      const seeded = await seedUserWorkspace({
        userId: "user-agent-delete-machines",
        token: "agent-delete-machines-token",
        workspaceId: "workspace-agent-delete-machines",
      });
      const doomed = await seedSecondAgent(seeded.workspaceId, "agent-doomed-machines");
      const db = drizzle(env.REGISTRY_DB, { schema });
      // EVERY thread of the doomed agent is archived. Under the old thread walk
      // this returned early and destroyed nothing.
      await db.insert(schema.threadIndex).values(
        [
          { id: "thr-archived-a", agentId: doomed, archivedAt: now },
          { id: "thr-archived-b", agentId: doomed, archivedAt: now },
          // Another agent's thread. Deleting THIS agent must not touch it.
          { id: "thr-other-agent", agentId: seeded.agentId, archivedAt: null },
        ].map((thread) => ({
          id: thread.id,
          workspaceId: seeded.workspaceId,
          agentId: thread.agentId,
          title: thread.id,
          runtime: "think" as const,
          source: "manual" as const,
          lastMessagePreview: "",
          archivedAt: thread.archivedAt,
          createdAt: now,
          updatedAt: now,
        })),
      );
      // A ledger row, so the delete's unconditional row drop is observable.
      await env.REGISTRY_DB.prepare(
        `INSERT INTO agent_sandboxes (agent_id, provider, sprite_name, status, created_at, last_used_at)
         VALUES (?1, 'sprites', 'nadi-b1-doomed', 'idle', 1, 1)`,
      )
        .bind(doomed)
        .run();

      const destroyed: Array<{ workspaceId: string; agentId: string }> = [];
      const destroy = vi
        .spyOn(AgentSandbox.prototype, "destroyForAgentDeletion")
        .mockImplementation(async (input) => {
          destroyed.push(input);
          return { destroyed: true };
        });
      try {
        const res = await SELF.fetch(`https://nadi.test/api/agents/${doomed}/archive`, {
          method: "POST",
          headers: cookie(seeded.token),
        });
        expect(res.status).toBe(200);
      } finally {
        destroy.mockRestore();
      }

      expect(destroyed).toEqual([{ workspaceId: seeded.workspaceId, agentId: doomed }]);
      // The row goes unconditionally. Keeping it would leave the sprite
      // accounted-for and therefore never reaped, forever.
      const row = await env.REGISTRY_DB.prepare(
        "SELECT agent_id FROM agent_sandboxes WHERE agent_id = ?1",
      )
        .bind(doomed)
        .first();
      expect(row).toBeNull();
    });

    it("still deletes the agent when a thread's machine cannot be reached", async () => {
      const seeded = await seedUserWorkspace({
        userId: "user-agent-delete-unreachable",
        token: "agent-delete-unreachable-token",
        workspaceId: "workspace-agent-delete-unreachable",
      });
      const doomed = await seedSecondAgent(seeded.workspaceId, "agent-doomed-unreachable");
      await drizzle(env.REGISTRY_DB, { schema }).insert(schema.threadIndex).values({
        id: "thr-unreachable",
        workspaceId: seeded.workspaceId,
        agentId: doomed,
        title: "unreachable",
        runtime: "think",
        source: "manual",
        lastMessagePreview: "",
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      });

      const shutdown = vi
        .spyOn(AgentSandbox.prototype, "destroyForAgentDeletion")
        // `mockImplementation`, not `mockRejectedValue`: the latter builds the
        // rejected promise eagerly and workerd reports it as an uncaught
        // rejection before the RPC ever hands it back.
        .mockImplementation(async () => {
          throw new Error("durable object unreachable");
        });
      try {
        const res = await SELF.fetch(`https://nadi.test/api/agents/${doomed}/archive`, {
          method: "POST",
          headers: cookie(seeded.token),
        });
        expect(res.status).toBe(200);
      } finally {
        shutdown.mockRestore();
      }

      const row = await drizzle(env.REGISTRY_DB, { schema })
        .select()
        .from(schema.agents)
        .where(eq(schema.agents.id, doomed))
        .get();
      expect(row?.archivedAt).toEqual(expect.any(Number));
    });
  });
});
