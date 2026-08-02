import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildThreadModelForWorkspace } from "../../src/agent/thread-agent";
import { registryDb } from "../../src/db/client";
import { WorkspaceRepository } from "../../src/db/repositories/workspaces";
import { upsertProviderConfig } from "../../src/db/repositories/provider-configs";
import { providerConfigs, users, workspaceMembers, workspaces } from "../../src/db/schema";
import { applyRegistryTestSchema } from "./helpers/registry";

const ALLOWED_WORKSPACE = "ws-workers-ai-allowed";
const DENIED_WORKSPACE = "ws-workers-ai-denied";

const cfg = {
  provider: "workers-ai",
  model: "@cf/moonshotai/kimi-k2.7-code",
  apiKey: "",
  systemPrompt: "You are Nadi.",
  modelInputModalities: ["text"],
  showReasoning: true,
  reasoningEffort: "medium" as const,
  modelSupportsReasoning: undefined,
};

async function seedWorkspace(id: string, userId: string, email: string) {
  const db = registryDb(env);
  await db.insert(users).values({
    id: userId,
    email,
    emailVerified: true,
    createdAt: new Date(1),
    updatedAt: new Date(1),
  });
  await db.insert(workspaces).values({ id, name: id, createdAt: 1 });
  await db.insert(workspaceMembers).values({
    workspaceId: id,
    userId,
    role: "owner",
    createdAt: 1,
  });
}

/**
 * The last line of defense for gated providers. Every workers-ai model — a turn,
 * a compaction, a title, an automaton firing, a subagent — is built through this
 * one function, and it is the only check that still applies after a thread row
 * was persisted. Without it, removing someone from the allowlist would leave
 * their existing threads happily billing our Cloudflare account.
 */
describe("gated provider model construction", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  beforeEach(async () => {
    const db = registryDb(env);
    await db.delete(providerConfigs);
    await db.delete(workspaceMembers);
    await db.delete(workspaces);
    await db.delete(users);
    await seedWorkspace(ALLOWED_WORKSPACE, "user-allowed", "you@example.com");
    await seedWorkspace(DENIED_WORKSPACE, "user-denied", "someone@else.com");
    env.WORKERS_AI_EMAILS = "you@example.com, teammate@example.com";
    // Miniflare has no AI binding; the subject here is the gate, not inference.
    // Tool calling through the real binding is verified separately, live.
    (env as { AI: unknown }).AI = { run: async () => ({}) };
  });

  it("resolves the workspace owner's email", async () => {
    const repo = new WorkspaceRepository(registryDb(env));
    await expect(repo.getOwnerEmail(ALLOWED_WORKSPACE)).resolves.toBe("you@example.com");
    await expect(repo.getOwnerEmail("ws-does-not-exist")).resolves.toBeNull();
  });

  it("builds a workers-ai model for an allowlisted owner, with no secret stored", async () => {
    const model = await buildThreadModelForWorkspace(env, cfg, ALLOWED_WORKSPACE);
    expect((model as { modelId: string }).modelId).toBe("@cf/moonshotai/kimi-k2.7-code");
  });

  it("refuses to build a workers-ai model when the owner is not allowlisted", async () => {
    await expect(buildThreadModelForWorkspace(env, cfg, DENIED_WORKSPACE)).rejects.toThrow(
      "provider_not_allowed:workers-ai",
    );
  });

  it("stops building models for a workspace whose owner was removed from the list", async () => {
    // The thread already exists and previously worked — the gate must re-deny it.
    await expect(buildThreadModelForWorkspace(env, cfg, ALLOWED_WORKSPACE)).resolves.toBeDefined();

    env.WORKERS_AI_EMAILS = "teammate@example.com";

    await expect(buildThreadModelForWorkspace(env, cfg, ALLOWED_WORKSPACE)).rejects.toThrow(
      "provider_not_allowed:workers-ai",
    );
  });

  it("builds for anyone once the allowlist is cleared (the kill-switch)", async () => {
    env.WORKERS_AI_EMAILS = "";
    await expect(buildThreadModelForWorkspace(env, cfg, DENIED_WORKSPACE)).resolves.toBeDefined();
  });

  it("fails clearly when the AI binding is absent for an allowlisted owner", async () => {
    // A deploy that lost the binding should say so, not throw from inside the
    // provider package. `{ binding: undefined }` is truthy, so this is easy to
    // get wrong.
    (env as { AI: unknown }).AI = undefined;
    await expect(buildThreadModelForWorkspace(env, cfg, ALLOWED_WORKSPACE)).rejects.toThrow(
      "workers_ai_binding_required",
    );
  });

  it("does not gate the other providers", async () => {
    // A non-allowlisted owner keeps working on a normal provider; the gate is
    // scoped to the providers that bill us and must not have become a general
    // provider block.
    await expect(
      buildThreadModelForWorkspace(
        env,
        { ...cfg, provider: "mock", model: "mock" },
        DENIED_WORKSPACE,
      ),
    ).resolves.toBeDefined();
  });

  // openai-oauth is ungated: each workspace brings its own ChatGPT tokens and
  // configures its own clean-egress proxy endpoint.
  describe("openai-oauth", () => {
    const oauthCfg = { ...cfg, provider: "openai-oauth", model: "gpt-5.4-mini" };

    it("builds for any workspace owner", async () => {
      await expect(
        buildThreadModelForWorkspace(env, oauthCfg, DENIED_WORKSPACE),
      ).resolves.toBeDefined();
      await expect(
        buildThreadModelForWorkspace(env, oauthCfg, ALLOWED_WORKSPACE),
      ).resolves.toBeDefined();
    });

    it("accepts a workspace-configured proxy endpoint URL", async () => {
      await upsertProviderConfig(env, DENIED_WORKSPACE, {
        provider: "openai-oauth",
        config: { baseUrl: "https://workspace-proxy.example.com" },
      });
      await expect(
        buildThreadModelForWorkspace(env, oauthCfg, DENIED_WORKSPACE),
      ).resolves.toBeDefined();
    });
  });
});
