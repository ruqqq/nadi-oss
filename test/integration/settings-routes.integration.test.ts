import { SELF, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import type { ProviderConfigProvider } from "../../src/db/repositories/provider-configs";
import { createWorkspaceSecretsServices } from "../../src/secrets";
import { applyRegistryTestSchema } from "./helpers/registry";

const now = 1_800_000_000_000;
const workspaceId = "ws-settings-routes";

function cookie(token: string) {
  return { cookie: `better-auth.session_token=${token}` };
}

async function clearKv() {
  const keys = await env.SECRETS_KV.list({ prefix: `workspaces/${workspaceId}/` });
  await Promise.all(keys.keys.map((key) => env.SECRETS_KV.delete(key.name)));
}

async function listWorkspaceSecretKeys() {
  return env.SECRETS_KV.list({ prefix: `workspaces/${workspaceId}/` });
}

async function clearRegistry() {
  const db = drizzle(env.REGISTRY_DB, { schema });
  await db.delete(schema.providerModelWhitelists);
  await db.delete(schema.providerModelCatalogs);
  await db.delete(schema.providerConfigs);
  await db.delete(schema.mcpToolPolicies);
  await db.delete(schema.mcpServers);
  await db.delete(schema.threadIndex);
  await db.delete(schema.agents);
  await db.delete(schema.workspaceMembers);
  await db.delete(schema.workspacePrivacySettings);
  await db.delete(schema.workspaces);
  await db.delete(schema.accounts);
  await db.delete(schema.sessions);
  await db.delete(schema.verifications);
  await db.delete(schema.users);
}

async function getProviderConfig(provider: ProviderConfigProvider) {
  const db = drizzle(env.REGISTRY_DB, { schema });
  return db
    .select()
    .from(schema.providerConfigs)
    .where(
      and(
        eq(schema.providerConfigs.workspaceId, workspaceId),
        eq(schema.providerConfigs.provider, provider),
      ),
    )
    .get();
}

async function seedUserWorkspace(input?: {
  role?: "owner" | "member";
  token?: string;
  provider?: string;
  model?: string;
}) {
  const db = drizzle(env.REGISTRY_DB, { schema });
  const role = input?.role ?? "owner";
  const userId = `user-${role}`;
  const token = input?.token ?? `${role}-token`;

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
  await db.insert(schema.workspaces).values({
    id: workspaceId,
    name: "Settings Routes",
    createdAt: now,
  });
  await db.insert(schema.workspaceMembers).values({
    workspaceId,
    userId,
    role,
    createdAt: now,
  });
  await db.insert(schema.agents).values({
    id: "agent-default",
    workspaceId,
    name: "Default",
    systemPrompt: "Initial prompt",
    provider: input?.provider ?? "mock",
    model: input?.model ?? "mock",
    createdAt: now,
  });

  return { token, workspaceId, userId };
}

describe("settings routes", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  beforeEach(async () => {
    await clearRegistry();
    await clearKv();
  });

  it("returns workspace, default agent settings, and provider metadata for an owner", async () => {
    const { token } = await seedUserWorkspace();
    const { writer } = createWorkspaceSecretsServices(env);
    await writer.ensureWorkspaceDek(workspaceId);
    await writer.set(workspaceId, "provider:openai", "sk-plain-should-not-leak", {
      updatedAt: "2026-06-29T12:00:00.000Z",
    });

    const res = await SELF.fetch("https://nadi.test/api/settings/agents/default", {
      headers: cookie(token),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      workspace: { id: workspaceId, name: "Settings Routes", createdAt: now },
      agent: {
        id: "agent-default",
        name: "Default",
        systemPrompt: "Initial prompt",
        provider: "mock",
        model: "mock",
      },
      providers: expect.arrayContaining([
        expect.objectContaining({
          provider: "openai",
          displayName: "OpenAI",
          defaultSecretName: "provider:openai",
          configuredSecretName: "provider:openai",
          secretPresent: true,
          secretUpdatedAt: "2026-06-29T12:00:00.000Z",
          previewAvailable: true,
        }),
      ]),
    });
    expect(JSON.stringify(body)).not.toContain("sk-plain-should-not-leak");
  });

  it("updates and returns showReasoning", async () => {
    const { token } = await seedUserWorkspace();

    const res = await SELF.fetch("https://nadi.test/api/settings/agents/default", {
      method: "PUT",
      headers: { ...cookie(token), "Content-Type": "application/json" },
      body: JSON.stringify({ agent: { showReasoning: false } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agent: { showReasoning: boolean } };
    expect(body.agent.showReasoning).toBe(false);

    const after = await SELF.fetch("https://nadi.test/api/settings/agents/default", {
      headers: cookie(token),
    });
    const afterBody = (await after.json()) as { agent: { showReasoning: boolean } };
    expect(afterBody.agent.showReasoning).toBe(false);
  });

  it("returns privacy settings disabled by default for the current owner workspace", async () => {
    const { token } = await seedUserWorkspace();

    const res = await SELF.fetch("https://nadi.test/api/settings/privacy", {
      headers: cookie(token),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      workspaceId,
      telemetryEnabled: false,
    });
  });

  it("updates workspace telemetry preference for an owner", async () => {
    const { token } = await seedUserWorkspace();

    const enabled = await SELF.fetch("https://nadi.test/api/settings/privacy", {
      method: "PUT",
      headers: { ...cookie(token), "Content-Type": "application/json" },
      body: JSON.stringify({ telemetryEnabled: true }),
    });
    expect(enabled.status).toBe(200);
    await expect(enabled.json()).resolves.toEqual({
      workspaceId,
      telemetryEnabled: true,
    });

    const afterEnable = await SELF.fetch("https://nadi.test/api/settings/privacy", {
      headers: cookie(token),
    });
    await expect(afterEnable.json()).resolves.toEqual({
      workspaceId,
      telemetryEnabled: true,
    });
  });

  it("rejects invalid privacy settings payloads", async () => {
    const { token } = await seedUserWorkspace();

    const res = await SELF.fetch("https://nadi.test/api/settings/privacy", {
      method: "PUT",
      headers: { ...cookie(token), "Content-Type": "application/json" },
      body: JSON.stringify({ telemetryEnabled: "yes" }),
    });

    expect(res.status).toBe(400);
    await expect(res.text()).resolves.toContain("telemetryEnabled must be a boolean");
  });

  it("searches provider models with static fallback", async () => {
    const { token } = await seedUserWorkspace();

    const res = await SELF.fetch(
      "https://nadi.test/api/settings/providers/qwen/models/search?q=max&limit=10",
      { headers: cookie(token) },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    await expect(res.json()).resolves.toMatchObject({
      provider: "qwen",
      query: "max",
      source: "static",
      models: [
        {
          id: "qwen3.7-max",
          inputModalities: ["text"],
          source: "static",
        },
      ],
    });
  });

  it("serves the full provider catalog and caches it", async () => {
    const { token } = await seedUserWorkspace();

    const res = await SELF.fetch("https://nadi.test/api/settings/providers/qwen/models", {
      headers: cookie(token),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      provider: string;
      models: Array<{ id: string }>;
      source: string;
      stale: boolean;
      fetchedAt: number;
    };
    expect(body.provider).toBe("qwen");
    expect(body.source).toBe("static");
    expect(body.stale).toBe(false);
    // The catalog is NOT clamped to the search route's limit.
    expect(body.models.length).toBeGreaterThan(1);

    const db = drizzle(env.REGISTRY_DB, { schema });
    const cached = await db
      .select()
      .from(schema.providerModelCatalogs)
      .where(
        and(
          eq(schema.providerModelCatalogs.workspaceId, workspaceId),
          eq(schema.providerModelCatalogs.provider, "qwen"),
        ),
      )
      .get();
    expect(cached).toBeDefined();
    expect(JSON.parse(cached?.modelsJson ?? "[]")).toHaveLength(body.models.length);
  });

  it("stores a curated model list and reports it on the provider view", async () => {
    const { token } = await seedUserWorkspace();

    const res = await SELF.fetch("https://nadi.test/api/settings/providers/qwen/models/whitelist", {
      method: "PUT",
      headers: { ...cookie(token), "Content-Type": "application/json" },
      body: JSON.stringify({
        models: [{ id: "qwen3.7-max", name: "Qwen 3.7 Max", inputModalities: ["text"] }],
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      provider: "qwen",
      whitelistModels: [{ id: "qwen3.7-max", name: "Qwen 3.7 Max", inputModalities: ["text"] }],
    });

    const settings = await SELF.fetch("https://nadi.test/api/settings/agents/default", {
      headers: cookie(token),
    });
    const body = (await settings.json()) as {
      providers: Array<{ provider: string; whitelistModels: unknown }>;
    };
    const qwen = body.providers.find((entry) => entry.provider === "qwen");
    expect(qwen?.whitelistModels).toEqual([
      { id: "qwen3.7-max", name: "Qwen 3.7 Max", inputModalities: ["text"], source: "static" },
    ]);
  });

  it("round-trips a hand-declared reasoning capability, keeping unknown distinct", async () => {
    const { token } = await seedUserWorkspace();

    const res = await SELF.fetch("https://nadi.test/api/settings/providers/qwen/models/whitelist", {
      method: "PUT",
      headers: { ...cookie(token), "Content-Type": "application/json" },
      body: JSON.stringify({
        models: [
          { id: "declared-yes", inputModalities: ["text"], reasoning: true },
          { id: "declared-no", inputModalities: ["text"], reasoning: false },
          // No `reasoning` key at all: UNKNOWN. Must not come back as `false`,
          // which would assert this model cannot think.
          { id: "undeclared", inputModalities: ["text"] },
          // Not a boolean — rejected rather than coerced.
          { id: "garbage", inputModalities: ["text"], reasoning: "yes" },
        ],
      }),
    });
    expect(res.status).toBe(200);

    const settings = await SELF.fetch("https://nadi.test/api/settings/agents/default", {
      headers: cookie(token),
    });
    const body = (await settings.json()) as {
      providers: Array<{
        provider: string;
        whitelistModels: Array<{ id: string; reasoning?: boolean }> | null;
      }>;
    };
    const models = body.providers.find((entry) => entry.provider === "qwen")?.whitelistModels ?? [];
    const byId = new Map(models.map((model) => [model.id, model]));

    // The parser rebuilds each record field by field, so an unhandled field is
    // dropped silently — a declaration would be lost on save with no error.
    expect(byId.get("declared-yes")?.reasoning).toBe(true);
    expect(byId.get("declared-no")?.reasoning).toBe(false);
    expect(byId.get("undeclared")).not.toHaveProperty("reasoning");
    expect(byId.get("garbage")).not.toHaveProperty("reasoning");
  });

  it("keeps an empty curated list distinct from no curation", async () => {
    const { token } = await seedUserWorkspace();
    const url = "https://nadi.test/api/settings/providers/qwen/models/whitelist";

    const emptied = await SELF.fetch(url, {
      method: "PUT",
      headers: { ...cookie(token), "Content-Type": "application/json" },
      body: JSON.stringify({ models: [] }),
    });
    expect(emptied.status).toBe(200);
    await expect(emptied.json()).resolves.toMatchObject({ whitelistModels: [] });

    // `null` is the only thing that clears curation back to "offer everything".
    const cleared = await SELF.fetch(url, {
      method: "PUT",
      headers: { ...cookie(token), "Content-Type": "application/json" },
      body: JSON.stringify({ models: null }),
    });
    expect(cleared.status).toBe(200);
    await expect(cleared.json()).resolves.toMatchObject({ whitelistModels: null });
  });

  it("rejects a malformed whitelist payload", async () => {
    const { token } = await seedUserWorkspace();

    const res = await SELF.fetch("https://nadi.test/api/settings/providers/qwen/models/whitelist", {
      method: "PUT",
      headers: { ...cookie(token), "Content-Type": "application/json" },
      body: JSON.stringify({ models: [{ name: "no id here" }] }),
    });

    expect(res.status).toBe(400);
  });

  it("requires a session for the catalog and whitelist routes", async () => {
    const catalog = await SELF.fetch("https://nadi.test/api/settings/providers/qwen/models");
    expect(catalog.status).toBe(401);

    const whitelist = await SELF.fetch(
      "https://nadi.test/api/settings/providers/qwen/models/whitelist",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ models: null }),
      },
    );
    expect(whitelist.status).toBe(401);
  });

  it("rejects an unsupported provider on the catalog route", async () => {
    const { token } = await seedUserWorkspace();

    const res = await SELF.fetch("https://nadi.test/api/settings/providers/nope/models", {
      headers: cookie(token),
    });
    expect(res.status).toBe(400);
  });

  it("drops the cached catalog when the provider key changes", async () => {
    const { token } = await seedUserWorkspace();
    const db = drizzle(env.REGISTRY_DB, { schema });

    await SELF.fetch("https://nadi.test/api/settings/providers/qwen/models", {
      headers: cookie(token),
    });
    const before = await db
      .select()
      .from(schema.providerModelCatalogs)
      .where(eq(schema.providerModelCatalogs.workspaceId, workspaceId))
      .all();
    expect(before).toHaveLength(1);

    await SELF.fetch("https://nadi.test/api/settings/providers/qwen/secret", {
      method: "PUT",
      headers: { ...cookie(token), "Content-Type": "application/json" },
      body: JSON.stringify({ value: "sk-new-key" }),
    });

    const after = await db
      .select()
      .from(schema.providerModelCatalogs)
      .where(eq(schema.providerModelCatalogs.workspaceId, workspaceId))
      .all();
    expect(after).toHaveLength(0);
  });

  it("keeps the curated list when the provider key changes", async () => {
    const { token } = await seedUserWorkspace();

    await SELF.fetch("https://nadi.test/api/settings/providers/qwen/models/whitelist", {
      method: "PUT",
      headers: { ...cookie(token), "Content-Type": "application/json" },
      body: JSON.stringify({ models: [{ id: "qwen3.7-max", inputModalities: ["text"] }] }),
    });

    await SELF.fetch("https://nadi.test/api/settings/providers/qwen/secret", {
      method: "PUT",
      headers: { ...cookie(token), "Content-Type": "application/json" },
      body: JSON.stringify({ value: "sk-rotated" }),
    });

    const settings = await SELF.fetch("https://nadi.test/api/settings/agents/default", {
      headers: cookie(token),
    });
    const body = (await settings.json()) as {
      providers: Array<{ provider: string; whitelistModels: unknown }>;
    };
    expect(body.providers.find((entry) => entry.provider === "qwen")?.whitelistModels).toEqual([
      { id: "qwen3.7-max", inputModalities: ["text"], source: "static" },
    ]);
  });

  it("updates system prompt, provider, and model for an owner", async () => {
    const { token } = await seedUserWorkspace();

    const res = await SELF.fetch("https://nadi.test/api/settings/agents/default", {
      method: "PUT",
      headers: { ...cookie(token), "Content-Type": "application/json" },
      body: JSON.stringify({
        agent: {
          systemPrompt: "  Updated prompt  ",
          provider: "openai",
          model: "  gpt-5.4-mini  ",
        },
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      workspace: { id: workspaceId, name: "Settings Routes", createdAt: now },
      agent: {
        id: "agent-default",
        systemPrompt: "Updated prompt",
        provider: "openai",
        model: "gpt-5.4-mini",
      },
      providers: expect.arrayContaining([
        expect.objectContaining({
          provider: "openai",
          secretPresent: false,
          previewAvailable: false,
        }),
      ]),
    });
  });

  it("updates and returns selected model input modalities", async () => {
    const { token } = await seedUserWorkspace();

    const res = await SELF.fetch("https://nadi.test/api/settings/agents/default", {
      method: "PUT",
      headers: { ...cookie(token), "Content-Type": "application/json" },
      body: JSON.stringify({
        agent: {
          modelInputModalities: ["text", "image", "file", "image"],
        },
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      agent: {
        modelInputModalities: ["text", "image", "file"],
      },
    });

    const after = await SELF.fetch("https://nadi.test/api/settings/agents/default", {
      headers: cookie(token),
    });
    await expect(after.json()).resolves.toMatchObject({
      agent: {
        modelInputModalities: ["text", "image", "file"],
      },
    });
  });

  it("allows existing mock providers for agent updates", async () => {
    const { token } = await seedUserWorkspace({ provider: "openai", model: "gpt-5.4-mini" });

    const res = await SELF.fetch("https://nadi.test/api/settings/agents/default", {
      method: "PUT",
      headers: { ...cookie(token), "Content-Type": "application/json" },
      body: JSON.stringify({
        agent: {
          provider: "mock-tool-call",
          model: "mock-tool-call",
        },
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      agent: {
        provider: "mock-tool-call",
        model: "mock-tool-call",
      },
    });
  });

  it("saves provider endpoint config through the settings route", async () => {
    const { token } = await seedUserWorkspace();
    const response = await SELF.fetch("https://nadi.test/api/settings/providers/qwen/config", {
      method: "PUT",
      headers: { ...cookie(token), "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl: "https://dashscope-us.aliyuncs.com/compatible-mode/v1/",
        auth: "bearer",
        body: { enable_thinking: true },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      provider: "qwen",
      endpointConfig: {
        baseUrl: "https://dashscope-us.aliyuncs.com/compatible-mode/v1",
        auth: "bearer",
        body: { enable_thinking: true },
      },
      usable: false,
    });
  });

  it("rejects unsafe transient provider verification endpoint config", async () => {
    const { token } = await seedUserWorkspace();

    const response = await SELF.fetch("https://nadi.test/api/settings/providers/qwen/verify", {
      method: "POST",
      headers: { ...cookie(token), "Content-Type": "application/json" },
      body: JSON.stringify({
        value: "dashscope-key",
        endpointConfig: {
          baseUrl: "http://example.com/compatible-mode/v1",
          auth: "bearer",
          body: {},
        },
      }),
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toContain("baseUrl must be HTTPS or localhost HTTP");
  });

  it("preserves existing unknown agent providers when provider is omitted", async () => {
    const { token } = await seedUserWorkspace({
      provider: "future-provider",
      model: "future-model",
    });

    const res = await SELF.fetch("https://nadi.test/api/settings/agents/default", {
      method: "PUT",
      headers: { ...cookie(token), "Content-Type": "application/json" },
      body: JSON.stringify({
        agent: {
          systemPrompt: "Updated prompt",
          model: "future-model-v2",
        },
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      agent: {
        provider: "future-provider",
        model: "future-model-v2",
      },
    });
  });

  it("returns 404 for non-owner members", async () => {
    const { token } = await seedUserWorkspace({ role: "member", token: "member-token" });

    const getRes = await SELF.fetch("https://nadi.test/api/settings/agents/default", {
      headers: cookie(token),
    });
    const putRes = await SELF.fetch("https://nadi.test/api/settings/agents/default", {
      method: "PUT",
      headers: { ...cookie(token), "Content-Type": "application/json" },
      body: JSON.stringify({ agent: { systemPrompt: "Nope" } }),
    });
    const secretRes = await SELF.fetch("https://nadi.test/api/settings/providers/openai/secret", {
      method: "PUT",
      headers: { ...cookie(token), "Content-Type": "application/json" },
      body: JSON.stringify({ value: "secret" }),
    });
    const previewRes = await SELF.fetch(
      "https://nadi.test/api/settings/providers/openai/secret-preview",
      {
        method: "POST",
        headers: { ...cookie(token), "Content-Type": "application/json" },
        body: JSON.stringify({ chars: 6 }),
      },
    );
    const configRes = await SELF.fetch("https://nadi.test/api/settings/providers/qwen/config", {
      method: "PUT",
      headers: { ...cookie(token), "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl: "https://dashscope-us.aliyuncs.com/compatible-mode/v1",
        auth: "bearer",
        body: {},
      }),
    });

    expect(getRes.status).toBe(404);
    expect(putRes.status).toBe(404);
    expect(secretRes.status).toBe(404);
    expect(previewRes.status).toBe(404);
    expect(configRes.status).toBe(404);
    expect(previewRes.headers.get("Cache-Control")).toBe("no-store");
  });

  it("stores provider secrets and returns a provider settings view without plaintext", async () => {
    const { token } = await seedUserWorkspace();

    const saved = await SELF.fetch("https://nadi.test/api/settings/providers/openai/secret", {
      method: "PUT",
      headers: { ...cookie(token), "Content-Type": "application/json" },
      body: JSON.stringify({
        value: "  sk-proj-secret-value\n",
        secretName: "  provider:openai-live  ",
      }),
    });

    expect(saved.status).toBe(200);
    const body = await saved.json();
    expect(body).toMatchObject({
      provider: "openai",
      displayName: "OpenAI",
      defaultSecretName: "provider:openai",
      configuredSecretName: "provider:openai-live",
      secretPresent: true,
      secretUpdatedAt: expect.any(String),
      previewAvailable: true,
    });
    expect(JSON.stringify(body)).not.toContain("sk-proj-secret-value");

    const { store } = createWorkspaceSecretsServices(env);
    await expect(store.get(workspaceId, "provider:openai-live")).resolves.toBe(
      "  sk-proj-secret-value\n",
    );
  });

  it("previews only a lazy secret prefix with no-store and 404s for missing secrets", async () => {
    const { token } = await seedUserWorkspace();
    await SELF.fetch("https://nadi.test/api/settings/providers/anthropic/secret", {
      method: "PUT",
      headers: { ...cookie(token), "Content-Type": "application/json" },
      body: JSON.stringify({ value: "anthropic-secret-value" }),
    });

    const preview = await SELF.fetch(
      "https://nadi.test/api/settings/providers/anthropic/secret-preview",
      {
        method: "POST",
        headers: { ...cookie(token), "Content-Type": "application/json" },
        body: JSON.stringify({ chars: 6 }),
      },
    );
    const missing = await SELF.fetch(
      "https://nadi.test/api/settings/providers/openrouter/secret-preview",
      {
        method: "POST",
        headers: { ...cookie(token), "Content-Type": "application/json" },
        body: JSON.stringify({ chars: 6 }),
      },
    );

    expect(preview.status).toBe(200);
    expect(preview.headers.get("Cache-Control")).toBe("no-store");
    const previewBody = await preview.json();
    expect(previewBody).toEqual({
      provider: "anthropic",
      secretName: "provider:anthropic",
      preview: "anthro",
      chars: 6,
      truncated: true,
      updatedAt: expect.any(String),
    });
    expect(JSON.stringify(previewBody)).not.toContain("anthropic-secret-value");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rejects malformed preview JSON without returning a secret prefix", async () => {
    const { token } = await seedUserWorkspace();
    await SELF.fetch("https://nadi.test/api/settings/providers/openai/secret", {
      method: "PUT",
      headers: { ...cookie(token), "Content-Type": "application/json" },
      body: JSON.stringify({ value: "openai-secret-value" }),
    });

    const malformed = await SELF.fetch(
      "https://nadi.test/api/settings/providers/openai/secret-preview",
      {
        method: "POST",
        headers: { ...cookie(token), "Content-Type": "application/json" },
        body: "{",
      },
    );

    expect(malformed.status).toBe(400);
    expect(malformed.headers.get("Cache-Control")).toBe("no-store");
    expect(await malformed.text()).not.toContain("openai");
  });

  it("allows an empty preview body and defaults to eight chars", async () => {
    const { token } = await seedUserWorkspace();
    await SELF.fetch("https://nadi.test/api/settings/providers/openrouter/secret", {
      method: "PUT",
      headers: { ...cookie(token), "Content-Type": "application/json" },
      body: JSON.stringify({ value: "openrouter-secret-value" }),
    });

    const preview = await SELF.fetch(
      "https://nadi.test/api/settings/providers/openrouter/secret-preview",
      {
        method: "POST",
        headers: { ...cookie(token), "Content-Type": "application/json" },
      },
    );

    expect(preview.status).toBe(200);
    expect(preview.headers.get("Cache-Control")).toBe("no-store");
    await expect(preview.json()).resolves.toMatchObject({
      provider: "openrouter",
      preview: "openrout",
      chars: 8,
      truncated: true,
    });
  });

  it("returns 400 no-store for unsupported preview providers", async () => {
    const { token } = await seedUserWorkspace();

    const mockProvider = await SELF.fetch(
      "https://nadi.test/api/settings/providers/mock/secret-preview",
      {
        method: "POST",
        headers: { ...cookie(token), "Content-Type": "application/json" },
        body: JSON.stringify({ chars: 6 }),
      },
    );
    const unknownProvider = await SELF.fetch(
      "https://nadi.test/api/settings/providers/bogus/secret-preview",
      {
        method: "POST",
        headers: { ...cookie(token), "Content-Type": "application/json" },
        body: JSON.stringify({ chars: 6 }),
      },
    );

    expect(mockProvider.status).toBe(400);
    expect(mockProvider.headers.get("Cache-Control")).toBe("no-store");
    expect(unknownProvider.status).toBe(400);
    expect(unknownProvider.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns 400 no-store for malformed preview provider path encoding", async () => {
    const { token } = await seedUserWorkspace();

    const malformedPath = await SELF.fetch(
      "https://nadi.test/api/settings/providers/%E0%A4%A/secret-preview",
      {
        method: "POST",
        headers: { ...cookie(token), "Content-Type": "application/json" },
        body: JSON.stringify({ chars: 6 }),
      },
    );

    expect(malformedPath.status).toBe(400);
    expect(malformedPath.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns 400 for invalid secret names without metadata or KV writes", async () => {
    const { token } = await seedUserWorkspace();

    const invalid = await SELF.fetch("https://nadi.test/api/settings/providers/openai/secret", {
      method: "PUT",
      headers: { ...cookie(token), "Content-Type": "application/json" },
      body: JSON.stringify({
        value: "sk-invalid-secret-name",
        secretName: "../provider/openai",
      }),
    });

    expect(invalid.status).toBe(400);
    expect(await invalid.text()).toContain("secretName");
    await expect(getProviderConfig("openai")).resolves.toBeUndefined();
    await expect(listWorkspaceSecretKeys()).resolves.toMatchObject({ keys: [] });
  });

  it("returns 400 for present non-string secret names without metadata or KV writes", async () => {
    const { token } = await seedUserWorkspace();
    const invalidSecretNames = [null, 123, { name: "provider:openai" }, ["provider:openai"]];

    for (const secretName of invalidSecretNames) {
      const invalid = await SELF.fetch("https://nadi.test/api/settings/providers/openai/secret", {
        method: "PUT",
        headers: { ...cookie(token), "Content-Type": "application/json" },
        body: JSON.stringify({
          value: "sk-invalid-secret-name-type",
          secretName,
        }),
      });

      expect(invalid.status).toBe(400);
      expect(await invalid.text()).toContain("secretName");
      await expect(getProviderConfig("openai")).resolves.toBeUndefined();
      await expect(listWorkspaceSecretKeys()).resolves.toMatchObject({ keys: [] });
    }
  });

  it("returns 400 for invalid agent updates and unsupported secret providers", async () => {
    const { token } = await seedUserWorkspace();

    const emptyPrompt = await SELF.fetch("https://nadi.test/api/settings/agents/default", {
      method: "PUT",
      headers: { ...cookie(token), "Content-Type": "application/json" },
      body: JSON.stringify({ agent: { systemPrompt: "  " } }),
    });
    const emptyModel = await SELF.fetch("https://nadi.test/api/settings/agents/default", {
      method: "PUT",
      headers: { ...cookie(token), "Content-Type": "application/json" },
      body: JSON.stringify({ agent: { model: "\n\t" } }),
    });
    const unsupportedAgentProvider = await SELF.fetch(
      "https://nadi.test/api/settings/agents/default",
      {
        method: "PUT",
        headers: { ...cookie(token), "Content-Type": "application/json" },
        body: JSON.stringify({ agent: { provider: "bogus" } }),
      },
    );
    const mockSecretProvider = await SELF.fetch(
      "https://nadi.test/api/settings/providers/mock/secret",
      {
        method: "PUT",
        headers: { ...cookie(token), "Content-Type": "application/json" },
        body: JSON.stringify({ value: "secret" }),
      },
    );
    const unknownSecretProvider = await SELF.fetch(
      "https://nadi.test/api/settings/providers/bogus/secret",
      {
        method: "PUT",
        headers: { ...cookie(token), "Content-Type": "application/json" },
        body: JSON.stringify({ value: "secret" }),
      },
    );
    const emptySecret = await SELF.fetch("https://nadi.test/api/settings/providers/openai/secret", {
      method: "PUT",
      headers: { ...cookie(token), "Content-Type": "application/json" },
      body: JSON.stringify({ value: "  " }),
    });

    expect(emptyPrompt.status).toBe(400);
    expect(emptyModel.status).toBe(400);
    expect(unsupportedAgentProvider.status).toBe(400);
    expect(mockSecretProvider.status).toBe(400);
    expect(unknownSecretProvider.status).toBe(400);
    expect(emptySecret.status).toBe(400);
  });

  it("returns 401 for unauthenticated settings requests", async () => {
    const getAgent = await SELF.fetch("https://nadi.test/api/settings/agents/default");
    const updateAgent = await SELF.fetch("https://nadi.test/api/settings/agents/default", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: { systemPrompt: "No session" } }),
    });
    const saveSecret = await SELF.fetch("https://nadi.test/api/settings/providers/openai/secret", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "secret" }),
    });
    const previewSecret = await SELF.fetch(
      "https://nadi.test/api/settings/providers/openai/secret-preview",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chars: 6 }),
      },
    );

    expect(getAgent.status).toBe(401);
    expect(updateAgent.status).toBe(401);
    expect(saveSecret.status).toBe(401);
    expect(previewSecret.status).toBe(401);
  });

  // The status mapping lives in unit tests (it would need real Exa network
  // access here); this covers the route contract up to the outbound call.
  describe("POST /api/settings/web-tools/exa-secret/verify", () => {
    const verifyUrl = "https://nadi.test/api/settings/web-tools/exa-secret/verify";

    it("requires a session", async () => {
      const response = await SELF.fetch(verifyUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "exa-key" }),
      });
      expect(response.status).toBe(401);
    });

    it("rejects an empty value without storing anything", async () => {
      const { token } = await seedUserWorkspace();

      const response = await SELF.fetch(verifyUrl, {
        method: "POST",
        headers: { ...cookie(token), "Content-Type": "application/json" },
        body: JSON.stringify({ value: "   " }),
      });

      expect(response.status).toBe(400);
      expect(response.headers.get("Cache-Control")).toBe("no-store");

      const settings = await SELF.fetch("https://nadi.test/api/settings/web-tools", {
        headers: cookie(token),
      });
      await expect(settings.json()).resolves.toMatchObject({ exaSecretPresent: false });
    });

    it("rejects other methods", async () => {
      const { token } = await seedUserWorkspace();
      const response = await SELF.fetch(verifyUrl, { headers: cookie(token) });
      expect(response.status).toBe(405);
    });
  });
});
