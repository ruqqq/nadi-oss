import { env } from "cloudflare:test";
import { and, asc, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registryDb } from "../../src/db/client";
import {
  defaultProviderSecretName,
  getProviderConfig,
  isProviderConfigProvider,
  listProviderConfigMetadata,
  upsertProviderConfig,
} from "../../src/db/repositories/provider-configs";
import { providerConfigs, workspaces } from "../../src/db/schema";
import { applyRegistryTestSchema } from "./helpers/registry";

describe("getProviderConfig", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  beforeEach(async () => {
    const db = registryDb(env);
    await db.delete(providerConfigs);
    await db.delete(workspaces);
    await db.insert(workspaces).values({
      id: "workspace-1",
      name: "Test Workspace",
      createdAt: 1,
    });
  });

  it("returns the newest matching provider config for a workspace", async () => {
    const db = registryDb(env);
    await db.insert(providerConfigs).values([
      {
        id: "old",
        workspaceId: "workspace-1",
        provider: "openai-oauth",
        displayName: "Old OAuth",
        secretName: "old-secret",
        createdAt: 1,
      },
      {
        id: "new",
        workspaceId: "workspace-1",
        provider: "openai-oauth",
        displayName: "New OAuth",
        secretName: "provider:openai-oauth",
        createdAt: 2,
      },
    ]);

    await expect(getProviderConfig(env, "workspace-1", "openai-oauth")).resolves.toMatchObject({
      id: "new",
      secretName: "provider:openai-oauth",
    });
  });

  it("returns undefined when no provider config exists", async () => {
    await expect(getProviderConfig(env, "workspace-1", "openai-oauth")).resolves.toBeUndefined();
  });

  it("lists newest provider configs with documented defaults", async () => {
    const db = registryDb(env);
    await db.insert(providerConfigs).values([
      {
        id: "cfg-openai-old",
        workspaceId: "workspace-1",
        provider: "openai",
        displayName: "Old OpenAI",
        secretName: "old-openai-secret",
        createdAt: 1,
      },
      {
        id: "cfg-openai-new",
        workspaceId: "workspace-1",
        provider: "openai",
        displayName: "Workspace OpenAI",
        secretName: "custom-openai-secret",
        createdAt: 2,
      },
    ]);

    await expect(listProviderConfigMetadata(env, "workspace-1")).resolves.toEqual([
      {
        provider: "openai",
        displayName: "Workspace OpenAI",
        defaultSecretName: "provider:openai",
        configuredSecretName: "custom-openai-secret",
        endpointConfig: { baseUrl: "", proxyUrl: "", auth: "bearer", body: {} },
      },
      {
        provider: "openai-oauth",
        displayName: "OpenAI OAuth",
        defaultSecretName: "provider:openai-oauth",
        configuredSecretName: "provider:openai-oauth",
        endpointConfig: { baseUrl: "", proxyUrl: "", auth: "bearer", body: {} },
      },
      {
        provider: "anthropic",
        displayName: "Anthropic",
        defaultSecretName: "provider:anthropic",
        configuredSecretName: "provider:anthropic",
        endpointConfig: { baseUrl: "", proxyUrl: "", auth: "bearer", body: {} },
      },
      {
        provider: "workers-ai",
        displayName: "Cloudflare Workers AI",
        defaultSecretName: "provider:workers-ai",
        configuredSecretName: "provider:workers-ai",
        endpointConfig: { baseUrl: "", proxyUrl: "", auth: "bearer", body: {} },
      },
      {
        provider: "openrouter",
        displayName: "OpenRouter",
        defaultSecretName: "provider:openrouter",
        configuredSecretName: "provider:openrouter",
        endpointConfig: { baseUrl: "", proxyUrl: "", auth: "bearer", body: {} },
      },
      {
        provider: "deepseek",
        displayName: "DeepSeek",
        defaultSecretName: "provider:deepseek",
        configuredSecretName: "provider:deepseek",
        endpointConfig: {
          baseUrl: "https://api.deepseek.com",
          proxyUrl: "",
          auth: "bearer",
          body: {},
        },
      },
      {
        provider: "zai",
        displayName: "Z.AI GLM",
        defaultSecretName: "provider:zai",
        configuredSecretName: "provider:zai",
        endpointConfig: {
          baseUrl: "https://api.z.ai/api/paas/v4",
          proxyUrl: "",
          auth: "bearer",
          body: {},
        },
      },
      {
        provider: "qwen",
        displayName: "Qwen / DashScope",
        defaultSecretName: "provider:qwen",
        configuredSecretName: "provider:qwen",
        endpointConfig: { baseUrl: "", proxyUrl: "", auth: "bearer", body: {} },
      },
      {
        provider: "opencode-go",
        displayName: "OpenCode Go",
        defaultSecretName: "provider:opencode-go",
        configuredSecretName: "provider:opencode-go",
        endpointConfig: {
          baseUrl: "https://opencode.ai/zen/go/v1",
          proxyUrl: "",
          auth: "bearer",
          body: {},
        },
      },
      {
        provider: "opencode-zen",
        displayName: "OpenCode Zen",
        defaultSecretName: "provider:opencode-zen",
        configuredSecretName: "provider:opencode-zen",
        endpointConfig: {
          baseUrl: "https://opencode.ai/zen/v1",
          proxyUrl: "",
          auth: "bearer",
          body: {},
        },
      },
      {
        provider: "openai-compatible",
        displayName: "OpenAI Compatible",
        defaultSecretName: "provider:openai-compatible",
        configuredSecretName: "provider:openai-compatible",
        endpointConfig: { baseUrl: "", proxyUrl: "", auth: "bearer", body: {} },
      },
    ]);
  });

  it("inserts provider config metadata changes as the newest row", async () => {
    const db = registryDb(env);
    const currentCreatedAt = 9_000_000_000_000;
    await db.insert(providerConfigs).values({
      id: "cfg-anthropic-current",
      workspaceId: "workspace-1",
      provider: "anthropic",
      displayName: "Current Claude",
      secretName: "anthropic-current",
      createdAt: currentCreatedAt,
    });

    await upsertProviderConfig(env, "workspace-1", {
      provider: "anthropic",
      displayName: "Claude",
      secretName: "anthropic-live",
    });

    const rows = await db
      .select()
      .from(providerConfigs)
      .where(
        and(
          eq(providerConfigs.workspaceId, "workspace-1"),
          eq(providerConfigs.provider, "anthropic"),
        ),
      );
    expect(rows).toHaveLength(2);
    await expect(getProviderConfig(env, "workspace-1", "anthropic")).resolves.toMatchObject({
      provider: "anthropic",
      displayName: "Claude",
      secretName: "anthropic-live",
      createdAt: currentCreatedAt + 1,
    });
  });

  it("uses documented defaults when provider config metadata fields are omitted", async () => {
    await expect(
      upsertProviderConfig(env, "workspace-1", { provider: "openai" }),
    ).resolves.toMatchObject({
      provider: "openai",
      displayName: "OpenAI",
      secretName: "provider:openai",
    });
  });

  it("resolves OpenAI-compatible provider config for runtime use", async () => {
    await upsertProviderConfig(env, "workspace-1", {
      provider: "deepseek",
      secretName: "provider:deepseek",
      config: {
        baseUrl: "https://api.deepseek.com",
        auth: "bearer",
        body: { reasoning_effort: "high" },
      },
    });

    const config = await getProviderConfig(env, "workspace-1", "deepseek");
    expect(config).toMatchObject({
      provider: "deepseek",
      secretName: "provider:deepseek",
    });
    expect(config?.configJson).toContain("reasoning_effort");
  });

  it("preserves current provider config metadata when fields are omitted", async () => {
    const db = registryDb(env);
    await db.insert(providerConfigs).values({
      id: "cfg-anthropic-current",
      workspaceId: "workspace-1",
      provider: "anthropic",
      displayName: "Current Claude",
      secretName: "anthropic-current",
      createdAt: 10,
    });

    await expect(
      upsertProviderConfig(env, "workspace-1", { provider: "anthropic" }),
    ).resolves.toMatchObject({
      provider: "anthropic",
      displayName: "Current Claude",
      secretName: "anthropic-current",
    });
  });

  it("preserves concurrent partial provider config metadata updates", async () => {
    const db = registryDb(env);
    await db.insert(providerConfigs).values({
      id: "cfg-openai-current",
      workspaceId: "workspace-1",
      provider: "openai",
      displayName: "Current OpenAI",
      secretName: "current-openai-secret",
      createdAt: 10,
    });

    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    try {
      await Promise.all([
        upsertProviderConfig(env, "workspace-1", {
          provider: "openai",
          displayName: "Workspace OpenAI",
        }),
        upsertProviderConfig(env, "workspace-1", {
          provider: "openai",
          secretName: "openai-live",
        }),
      ]);
    } finally {
      nowSpy.mockRestore();
    }

    const rows = await db
      .select()
      .from(providerConfigs)
      .where(
        and(eq(providerConfigs.workspaceId, "workspace-1"), eq(providerConfigs.provider, "openai")),
      )
      .orderBy(asc(providerConfigs.createdAt));
    expect(rows).toHaveLength(3);
    await expect(getProviderConfig(env, "workspace-1", "openai")).resolves.toMatchObject({
      displayName: "Workspace OpenAI",
      secretName: "openai-live",
    });
  });

  it("allocates increasing timestamps for same-clock provider config writes", async () => {
    const db = registryDb(env);
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);

    try {
      const [first, second] = await Promise.all([
        upsertProviderConfig(env, "workspace-1", {
          provider: "openrouter",
          displayName: "First OpenRouter",
          secretName: "openrouter-first",
        }),
        upsertProviderConfig(env, "workspace-1", {
          provider: "openrouter",
          displayName: "Second OpenRouter",
          secretName: "openrouter-second",
        }),
      ]);

      const rows = await db
        .select()
        .from(providerConfigs)
        .where(
          and(
            eq(providerConfigs.workspaceId, "workspace-1"),
            eq(providerConfigs.provider, "openrouter"),
          ),
        )
        .orderBy(asc(providerConfigs.createdAt));
      const writtenIds = new Set([first.id, second.id]);
      const createdAts = rows.map((row) => row.createdAt);
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => writtenIds.has(row.id))).toBe(true);
      expect(new Set(createdAts).size).toBe(2);
      const [oldestCreatedAt, newestCreatedAt] = createdAts;
      if (oldestCreatedAt === undefined || newestCreatedAt === undefined) {
        throw new Error("expected provider config timestamps");
      }
      expect(newestCreatedAt).toBeGreaterThan(oldestCreatedAt);
      const persistedNewest = rows.at(-1);
      if (!persistedNewest) throw new Error("expected newest provider config");
      await expect(getProviderConfig(env, "workspace-1", "openrouter")).resolves.toMatchObject({
        id: persistedNewest.id,
        displayName: persistedNewest.displayName,
        secretName: persistedNewest.secretName,
        createdAt: persistedNewest.createdAt,
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("rejects unsupported provider ids", () => {
    expect(isProviderConfigProvider("mock")).toBe(false);
    expect(isProviderConfigProvider("openai")).toBe(true);
    expect(isProviderConfigProvider("deepseek")).toBe(true);
    expect(isProviderConfigProvider("zai")).toBe(true);
    expect(isProviderConfigProvider("qwen")).toBe(true);
    expect(isProviderConfigProvider("opencode-go")).toBe(true);
    expect(isProviderConfigProvider("openai-compatible")).toBe(true);
  });

  it("rejects unsupported provider metadata writes from untyped callers", async () => {
    await expect(
      upsertProviderConfig(env, "workspace-1", {
        provider: "mock",
        displayName: "Mock",
        secretName: "mock-secret",
      } as unknown as Parameters<typeof upsertProviderConfig>[2]),
    ).rejects.toThrow("unsupported_provider:mock");

    const row = await env.REGISTRY_DB.prepare(
      "SELECT COUNT(*) AS count FROM provider_configs WHERE provider = ?",
    )
      .bind("mock")
      .first<{ count: number }>();
    expect(row?.count).toBe(0);
  });

  it("uses provider:openai-oauth as the default OpenAI OAuth secret name", () => {
    expect(defaultProviderSecretName("openai-oauth")).toBe("provider:openai-oauth");
  });
});
