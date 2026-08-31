import { SELF, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import type { Env } from "../../src/env";
import * as schema from "../../src/db/schema";
import { ComputeEnvSecretsStore } from "../../src/compute/env-secrets";
import { createWorkspaceSecretsServices } from "../../src/secrets";
import { applyRegistryTestSchema } from "./helpers/registry";

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
  await db.delete(schema.workbenches);
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
  const userId = input?.userId ?? "user-workbench-routes";
  const token = input?.token ?? "workbench-routes-token";

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
  const userId = input?.userId ?? "user-workbench-routes";
  const token = input?.token ?? "workbench-routes-token";
  const workspaceId = input?.workspaceId ?? "workspace-workbench-routes";

  await insertUserSession({ userId, token });
  const workspace = await insertWorkspaceMembership({
    userId,
    workspaceId,
    ...(input?.memberCreatedAt !== undefined ? { memberCreatedAt: input.memberCreatedAt } : {}),
    ...(input?.agentCreatedAt !== undefined ? { agentCreatedAt: input.agentCreatedAt } : {}),
  });

  return { userId, token, workspaceId: workspace.workspaceId, agentId: workspace.agentId };
}

describe("workbench routes", () => {
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

  it("supports workbench CRUD, repo-set, env-vars, secrets, and archive", async () => {
    const seeded = await seedUserWorkspace();

    const createRes = await SELF.fetch("https://nadi.test/api/workbenches", {
      method: "POST",
      headers: { ...cookie(seeded.token), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "  staging  ", description: "Staging env" }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      workbench: { id: string; name: string; description: string };
    };
    expect(created.workbench).toMatchObject({
      id: expect.any(String),
      name: "staging",
      description: "Staging env",
      archivedAt: null,
    });
    const workbenchId = created.workbench.id;

    const listRes = await SELF.fetch("https://nadi.test/api/workbenches?status=all", {
      headers: cookie(seeded.token),
    });
    expect(listRes.status).toBe(200);
    const listed = (await listRes.json()) as { workbenches: Array<{ id: string }> };
    expect(listed.workbenches.some((w) => w.id === workbenchId)).toBe(true);

    const patchRes = await SELF.fetch(`https://nadi.test/api/workbenches/${workbenchId}`, {
      method: "PATCH",
      headers: { ...cookie(seeded.token), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "  staging-renamed  " }),
    });
    expect(patchRes.status).toBe(200);
    await expect(patchRes.json()).resolves.toEqual({
      workbench: expect.objectContaining({ id: workbenchId, name: "staging-renamed" }),
    });

    const repoEntry = {
      source: "github",
      name: "repo-workbench-routes",
      url: "https://github.com/acme/repo-workbench-routes.git",
      checkoutPathName: "repo-workbench-routes",
      defaultBranch: "main",
      rootDirectory: "",
      setupCommand: "",
      packageManager: "",
      sourceInstallationId: null,
      githubRepoId: null,
    };

    const putReposRes = await SELF.fetch(
      `https://nadi.test/api/workbenches/${workbenchId}/repositories`,
      {
        method: "PUT",
        headers: { ...cookie(seeded.token), "Content-Type": "application/json" },
        body: JSON.stringify([repoEntry]),
      },
    );
    expect(putReposRes.status).toBe(200);

    const getAfterRepos = await SELF.fetch(`https://nadi.test/api/workbenches/${workbenchId}`, {
      headers: cookie(seeded.token),
    });
    expect(getAfterRepos.status).toBe(200);
    const afterRepos = (await getAfterRepos.json()) as {
      workbench: { repositories: Array<{ name: string; url: string; source: string }> };
    };
    expect(afterRepos.workbench.repositories).toHaveLength(1);
    expect(afterRepos.workbench.repositories[0]).toMatchObject({
      name: "repo-workbench-routes",
      url: "https://github.com/acme/repo-workbench-routes.git",
      source: "github",
    });

    const putEnvVarsRes = await SELF.fetch(
      `https://nadi.test/api/workbenches/${workbenchId}/env-vars`,
      {
        method: "PUT",
        headers: { ...cookie(seeded.token), "Content-Type": "application/json" },
        body: JSON.stringify({ envVars: { NODE_ENV: "staging" } }),
      },
    );
    expect(putEnvVarsRes.status).toBe(200);

    const getAfterEnvVars = await SELF.fetch(`https://nadi.test/api/workbenches/${workbenchId}`, {
      headers: cookie(seeded.token),
    });
    const afterEnvVars = (await getAfterEnvVars.json()) as {
      workbench: { envVars: Record<string, string> };
    };
    expect(afterEnvVars.workbench.envVars).toEqual({ NODE_ENV: "staging" });

    const putSecretRes = await SELF.fetch(
      `https://nadi.test/api/workbenches/${workbenchId}/secrets/GH_TOKEN`,
      {
        method: "PUT",
        headers: { ...cookie(seeded.token), "Content-Type": "application/json" },
        body: JSON.stringify({ value: "secret-value" }),
      },
    );
    expect(putSecretRes.status).toBe(200);

    const getAfterSecret = await SELF.fetch(`https://nadi.test/api/workbenches/${workbenchId}`, {
      headers: cookie(seeded.token),
    });
    const afterSecretBody = await getAfterSecret.text();
    expect(afterSecretBody).not.toContain("secret-value");
    const afterSecret = JSON.parse(afterSecretBody) as {
      workbench: { secretEnvNames: string[] };
    };
    expect(afterSecret.workbench.secretEnvNames).toEqual(["GH_TOKEN"]);

    const deleteSecretRes = await SELF.fetch(
      `https://nadi.test/api/workbenches/${workbenchId}/secrets/GH_TOKEN`,
      { method: "DELETE", headers: cookie(seeded.token) },
    );
    expect(deleteSecretRes.status).toBe(200);

    const getAfterDelete = await SELF.fetch(`https://nadi.test/api/workbenches/${workbenchId}`, {
      headers: cookie(seeded.token),
    });
    const afterDelete = (await getAfterDelete.json()) as {
      workbench: { secretEnvNames: string[] };
    };
    expect(afterDelete.workbench.secretEnvNames).toEqual([]);

    const archiveRes = await SELF.fetch(
      `https://nadi.test/api/workbenches/${workbenchId}/archive`,
      { method: "POST", headers: cookie(seeded.token) },
    );
    expect(archiveRes.status).toBe(200);
    await expect(archiveRes.json()).resolves.toEqual({
      workbench: expect.objectContaining({ id: workbenchId, archivedAt: expect.any(Number) }),
    });

    const listActiveRes = await SELF.fetch("https://nadi.test/api/workbenches", {
      headers: cookie(seeded.token),
    });
    const listActive = (await listActiveRes.json()) as { workbenches: Array<{ id: string }> };
    expect(listActive.workbenches.some((w) => w.id === workbenchId)).toBe(false);
  });

  describe("secret names come from the D1 index, not the KV list", () => {
    function secretStore() {
      return new ComputeEnvSecretsStore(createWorkspaceSecretsServices(env as unknown as Env));
    }

    async function insertWorkbench(input: {
      id: string;
      workspaceId: string;
      secretNamesBackfilled: boolean;
    }) {
      const db = drizzle(env.REGISTRY_DB, { schema });
      await db.insert(schema.workbenches).values({
        id: input.id,
        workspaceId: input.workspaceId,
        name: "Legacy WB",
        secretNamesBackfilled: input.secretNamesBackfilled,
        createdAt: now,
        updatedAt: now,
      });
    }

    async function getSecretNames(id: string, token: string): Promise<string[]> {
      const res = await SELF.fetch(`https://nadi.test/api/workbenches/${id}`, {
        headers: cookie(token),
      });
      const body = (await res.json()) as { workbench: { secretEnvNames: string[] } };
      return body.workbench.secretEnvNames;
    }

    it("seeds the D1 index from pre-existing KV secrets on first read, then flips the flag", async () => {
      const seeded = await seedUserWorkspace();
      const workbenchId = "env_legacy_backfill";
      // A workbench predating the D1 index: KV holds the secret, D1 does not.
      await insertWorkbench({
        id: workbenchId,
        workspaceId: seeded.workspaceId,
        secretNamesBackfilled: false,
      });
      await secretStore().setEnvironment(seeded.workspaceId, workbenchId, "LEGACY_KEY", "v1");

      // First read backfills from the KV list and returns the name.
      expect(await getSecretNames(workbenchId, seeded.token)).toEqual(["LEGACY_KEY"]);

      const db = drizzle(env.REGISTRY_DB, { schema });
      const names = await db
        .select({ name: schema.agentSecretNames.name })
        .from(schema.agentSecretNames)
        .all();
      expect(names.map((n) => n.name)).toEqual(["LEGACY_KEY"]);
      const wb = await db.select().from(schema.workbenches).get();
      expect(wb?.secretNamesBackfilled).toBe(true);
    });

    it("keeps a secret name listed even after its KV value is gone (D1 is authoritative)", async () => {
      const seeded = await seedUserWorkspace();
      const createRes = await SELF.fetch("https://nadi.test/api/workbenches", {
        method: "POST",
        headers: { ...cookie(seeded.token), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "WB" }),
      });
      const workbenchId = ((await createRes.json()) as { workbench: { id: string } }).workbench.id;

      await SELF.fetch(`https://nadi.test/api/workbenches/${workbenchId}/secrets/FOO`, {
        method: "PUT",
        headers: { ...cookie(seeded.token), "Content-Type": "application/json" },
        body: JSON.stringify({ value: "bar" }),
      });
      expect(await getSecretNames(workbenchId, seeded.token)).toEqual(["FOO"]);

      // Drop the KV value out from under the route. Under the old code the name
      // came from the KV list and would vanish; the D1 index keeps it.
      await secretStore().deleteEnvironment(seeded.workspaceId, workbenchId, "FOO");
      expect(await getSecretNames(workbenchId, seeded.token)).toEqual(["FOO"]);
    });

    it("deletes a name on a legacy workbench without the stale KV list re-adding it", async () => {
      const seeded = await seedUserWorkspace();
      const workbenchId = "env_legacy_delete";
      await insertWorkbench({
        id: workbenchId,
        workspaceId: seeded.workspaceId,
        secretNamesBackfilled: false,
      });
      await secretStore().setEnvironment(seeded.workspaceId, workbenchId, "OLD", "v1");

      const res = await SELF.fetch(`https://nadi.test/api/workbenches/${workbenchId}/secrets/OLD`, {
        method: "DELETE",
        headers: cookie(seeded.token),
      });
      expect(res.status).toBe(200);
      expect(await getSecretNames(workbenchId, seeded.token)).toEqual([]);
    });

    it("persists every name when secrets are added concurrently", async () => {
      const seeded = await seedUserWorkspace();
      const createRes = await SELF.fetch("https://nadi.test/api/workbenches", {
        method: "POST",
        headers: { ...cookie(seeded.token), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "WB" }),
      });
      const workbenchId = ((await createRes.json()) as { workbench: { id: string } }).workbench.id;

      const names = ["ALPHA", "BRAVO", "CHARLIE", "DELTA"];
      await Promise.all(
        names.map((name) =>
          SELF.fetch(`https://nadi.test/api/workbenches/${workbenchId}/secrets/${name}`, {
            method: "PUT",
            headers: { ...cookie(seeded.token), "Content-Type": "application/json" },
            body: JSON.stringify({ value: `v-${name}` }),
          }),
        ),
      );

      expect(await getSecretNames(workbenchId, seeded.token)).toEqual(names);
    });
  });

  describe("resourceProfile", () => {
    let token = "";

    beforeEach(async () => {
      const seeded = await seedUserWorkspace();
      token = seeded.token;
    });

    async function createWorkbench(body: Record<string, unknown>) {
      const res = await SELF.fetch("https://nadi.test/api/workbenches", {
        method: "POST",
        headers: { ...cookie(token), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as {
        workbench: { id: string; name: string; resourceProfile: string };
      };
      return json.workbench;
    }

    async function patchWorkbenchRaw(id: string, body: Record<string, unknown>) {
      return SELF.fetch(`https://nadi.test/api/workbenches/${id}`, {
        method: "PATCH",
        headers: { ...cookie(token), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    async function patchWorkbench(id: string, body: Record<string, unknown>) {
      const res = await patchWorkbenchRaw(id, body);
      const json = (await res.json()) as { workbench: { id: string; resourceProfile: string } };
      return json.workbench;
    }

    it("defaults resourceProfile to small and round-trips an update", async () => {
      const created = await createWorkbench({ name: "Heavy" });
      expect(created.resourceProfile).toBe("small");

      const patched = await patchWorkbench(created.id, { resourceProfile: "medium" });
      expect(patched.resourceProfile).toBe("medium");
    });

    it("rejects an unknown resourceProfile", async () => {
      const created = await createWorkbench({ name: "Bad" });
      const originalName = created.name;

      const res = await patchWorkbenchRaw(created.id, {
        name: "Still valid",
        resourceProfile: "enormous",
      });
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toContain("Invalid resourceProfile");

      // Verify the workbench was not mutated
      const getRes = await SELF.fetch(`https://nadi.test/api/workbenches/${created.id}`, {
        headers: cookie(token),
      });
      const fetched = (await getRes.json()) as { workbench: { name: string } };
      expect(fetched.workbench.name).toBe(originalName);
    });
  });

  it("returns 404 for a non-member accessing a workbench", async () => {
    const owner = await seedUserWorkspace();
    const outsider = await seedUserWorkspace({
      userId: "workbench-outsider-user",
      token: "workbench-outsider-token",
      workspaceId: "workspace-workbench-outsider",
      memberCreatedAt: now + 1,
      agentCreatedAt: now + 1,
    });

    const createRes = await SELF.fetch("https://nadi.test/api/workbenches", {
      method: "POST",
      headers: { ...cookie(owner.token), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "owner-workbench" }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { workbench: { id: string } };

    const res = await SELF.fetch(`https://nadi.test/api/workbenches/${created.workbench.id}`, {
      headers: cookie(outsider.token),
    });
    expect(res.status).toBe(404);
  });
});
