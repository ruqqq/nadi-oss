import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GithubInstallationRepository } from "../../src/db/repositories/github-installations";
import * as schema from "../../src/db/schema";
import { applyRegistryTestSchema } from "./helpers/registry";

async function seedWorkspace(registryDb: typeof env.REGISTRY_DB, workspaceId: string) {
  await registryDb
    .prepare("INSERT OR IGNORE INTO workspaces (id, name, created_at) VALUES (?, ?, ?)")
    .bind(workspaceId, workspaceId, 1)
    .run();
}

describe("GithubInstallationRepository", () => {
  const workspaceId = "workspace-gh";
  const repo = () => new GithubInstallationRepository(drizzle(env.REGISTRY_DB, { schema }));
  const base = {
    accountLogin: "acme",
    accountType: "org" as const,
    repositorySelection: "all" as const,
    connectedByUserId: "u1",
  };

  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });
  const clean = async () => {
    await env.REGISTRY_DB.prepare("DELETE FROM github_app_installations").run();
    await env.REGISTRY_DB.prepare("DELETE FROM workspaces").run();
  };
  beforeEach(async () => {
    await clean();
    await seedWorkspace(env.REGISTRY_DB, workspaceId);
  });
  afterEach(clean);

  it("upserts idempotently on (workspace, installationId)", async () => {
    await repo().upsert({ workspaceId, installationId: 42, ...base });
    await repo().upsert({ workspaceId, installationId: 42, ...base, accountLogin: "acme-2" });
    const all = await repo().listForWorkspace(workspaceId);
    expect(all).toHaveLength(1);
    expect(all[0]?.accountLogin).toBe("acme-2");
  });

  it("finds an active installation by owner and flips status", async () => {
    await repo().upsert({ workspaceId, installationId: 42, ...base });
    expect((await repo().getActiveByOwner(workspaceId, "acme"))?.installationId).toBe(42);
    await repo().markStatus(workspaceId, 42, "disconnected");
    expect(await repo().getActiveByOwner(workspaceId, "acme")).toBeUndefined();
  });
});
