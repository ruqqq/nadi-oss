import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyGithubToken } from "../../src/agent/github-token-wiring";
import { GithubInstallationRepository } from "../../src/db/repositories/github-installations";
import * as schema from "../../src/db/schema";
import { applyRegistryTestSchema } from "./helpers/registry";

const config = {
  appId: "1",
  privateKeyPkcs8Pem: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----",
  clientId: "c",
  clientSecret: "s",
  slug: "nadi",
};

async function seedWorkspace(registryDb: typeof env.REGISTRY_DB, workspaceId: string) {
  await registryDb
    .prepare("INSERT OR IGNORE INTO workspaces (id, name, created_at) VALUES (?, ?, ?)")
    .bind(workspaceId, workspaceId, 1)
    .run();
}

describe("applyGithubToken", () => {
  const workspaceId = "workspace-ghwire";
  const db = () => drizzle(env.REGISTRY_DB, { schema });

  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });
  beforeEach(async () => {
    await env.REGISTRY_DB.prepare("DELETE FROM github_app_installations").run();
    await env.REGISTRY_DB.prepare("DELETE FROM workspaces").run();
    await seedWorkspace(env.REGISTRY_DB, workspaceId);
    await new GithubInstallationRepository(db()).upsert({
      workspaceId,
      installationId: 42,
      accountLogin: "acme",
      accountType: "org",
      repositorySelection: "all",
      connectedByUserId: "u1",
    });
  });

  it("adds GH_TOKEN for a covered repo when none is set", async () => {
    const client = {
      mintInstallationToken: vi.fn().mockResolvedValue({ token: "ghs_x", expiresAt: "" }),
    };
    const out = await applyGithubToken({
      db: db(),
      workspaceId,
      config,
      existingEnv: {},
      repoUrls: ["https://github.com/acme/api"],
      clientFactory: () => client as never,
    });
    expect(out.GH_TOKEN).toBe("ghs_x");
  });

  it("leaves a manual GH_TOKEN untouched", async () => {
    const client = { mintInstallationToken: vi.fn() };
    const out = await applyGithubToken({
      db: db(),
      workspaceId,
      config,
      existingEnv: { GH_TOKEN: "manual" },
      repoUrls: ["https://github.com/acme/api"],
      clientFactory: () => client as never,
    });
    expect(out.GH_TOKEN).toBe("manual");
    expect(client.mintInstallationToken).not.toHaveBeenCalled();
  });
});
