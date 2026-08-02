import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registryDb } from "../../src/db/client";
import {
  getProviderConfig,
  upsertProviderConfig,
} from "../../src/db/repositories/provider-configs";
import { providerConfigs, workspaces } from "../../src/db/schema";
import {
  buildWorkspaceDekKey,
  buildWorkspaceSecretKey,
  createWorkspaceSecretsServices,
} from "../../src/secrets";
import {
  listProviderSettings,
  parseProvider,
  previewProviderSecret,
  saveProviderEndpointConfig,
  saveProviderSecret,
} from "../../src/settings/provider-settings";
import { applyRegistryTestSchema } from "./helpers/registry";

const workspaceId = "ws-provider-settings";

async function clearSecretsFor(id: string) {
  const list = await env.SECRETS_KV.list({ prefix: `workspaces/${id}/` });
  await Promise.all(list.keys.map((key) => env.SECRETS_KV.delete(key.name)));
}

describe("provider settings service", () => {
  beforeAll(async () => {
    await applyRegistryTestSchema(env.REGISTRY_DB);
  });

  beforeEach(async () => {
    const db = registryDb(env);
    await db.delete(providerConfigs);
    await db.delete(workspaces);
    await db.insert(workspaces).values({
      id: workspaceId,
      name: "Provider Settings",
      createdAt: 1,
    });
    await clearSecretsFor(workspaceId);
  });

  it("parses supported configurable providers only", () => {
    expect(parseProvider("openai")).toBe("openai");
    expect(parseProvider("anthropic")).toBe("anthropic");
    expect(parseProvider("openrouter")).toBe("openrouter");
    expect(parseProvider("openai-oauth")).toBe("openai-oauth");
    expect(parseProvider("mock")).toBeNull();
    expect(parseProvider("")).toBeNull();
  });

  it("lists provider metadata from KV metadata without plaintext", async () => {
    const updatedAt = "2026-06-29T12:00:00.000Z";
    await upsertProviderConfig(env, workspaceId, {
      provider: "openai",
      displayName: "Workspace OpenAI",
      secretName: "custom-openai-secret",
    });
    const { writer } = createWorkspaceSecretsServices(env);
    await writer.ensureWorkspaceDek(workspaceId);
    await writer.set(workspaceId, "custom-openai-secret", "sk-proj-secret-value", {
      updatedAt,
    });

    const providers = await listProviderSettings(env, workspaceId, null);

    expect(providers.find((provider) => provider.provider === "openai")).toEqual({
      provider: "openai",
      displayName: "Workspace OpenAI",
      defaultSecretName: "provider:openai",
      configuredSecretName: "custom-openai-secret",
      secretPresent: true,
      secretUpdatedAt: updatedAt,
      previewAvailable: true,
      endpointConfig: {
        baseUrl: "",
        proxyUrl: "",
        auth: "bearer",
        body: {},
      },
      usable: true,
      // Uncurated: the whole catalog is offered.
      whitelistModels: null,
    });
    expect(providers.find((provider) => provider.provider === "anthropic")).toMatchObject({
      provider: "anthropic",
      configuredSecretName: "provider:anthropic",
      secretPresent: false,
      secretUpdatedAt: null,
      previewAvailable: false,
    });
    expect(JSON.stringify(providers)).not.toContain("sk-proj-secret-value");
  });

  it("parses OpenAI-compatible providers and exposes defaults", async () => {
    expect(parseProvider("deepseek")).toBe("deepseek");
    expect(parseProvider("zai")).toBe("zai");
    expect(parseProvider("qwen")).toBe("qwen");
    expect(parseProvider("opencode-go")).toBe("opencode-go");
    expect(parseProvider("openai-compatible")).toBe("openai-compatible");

    const providers = await listProviderSettings(env, workspaceId, null);

    expect(providers.find((provider) => provider.provider === "deepseek")).toMatchObject({
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
      usable: false,
    });
    expect(providers.find((provider) => provider.provider === "zai")).toMatchObject({
      provider: "zai",
      displayName: "Z.AI GLM",
      endpointConfig: {
        baseUrl: "https://api.z.ai/api/paas/v4",
        proxyUrl: "",
        auth: "bearer",
        body: {},
      },
      usable: false,
    });
    expect(providers.find((provider) => provider.provider === "qwen")).toMatchObject({
      provider: "qwen",
      displayName: "Qwen / DashScope",
      endpointConfig: {
        baseUrl: "",
        proxyUrl: "",
        auth: "bearer",
        body: {},
      },
      usable: false,
    });
    expect(providers.find((provider) => provider.provider === "opencode-go")).toMatchObject({
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
      usable: false,
    });
  });

  it("stores non-secret endpoint config separately from encrypted secrets", async () => {
    const saved = await saveProviderEndpointConfig(env, workspaceId, "qwen", {
      baseUrl: "https://dashscope-us.aliyuncs.com/compatible-mode/v1/",
      auth: "bearer",
      body: {
        enable_thinking: true,
        reasoning_effort: "high",
        ignored: "value",
      },
    });

    expect(saved.endpointConfig).toEqual({
      baseUrl: "https://dashscope-us.aliyuncs.com/compatible-mode/v1",
      proxyUrl: "",
      auth: "bearer",
      body: {
        enable_thinking: true,
        reasoning_effort: "high",
      },
    });
    expect(saved.usable).toBe(false);

    const config = await getProviderConfig(env, workspaceId, "qwen");
    expect(config?.configJson).toContain("dashscope-us.aliyuncs.com");
    expect(config?.configJson).not.toContain("sk-");
  });

  it("marks no-auth custom endpoint usable without a secret", async () => {
    const saved = await saveProviderEndpointConfig(env, workspaceId, "openai-compatible", {
      baseUrl: "http://localhost:11434/v1",
      auth: "none",
      body: {},
    });

    expect(saved).toMatchObject({
      provider: "openai-compatible",
      secretPresent: false,
      endpointConfig: {
        baseUrl: "http://localhost:11434/v1",
        auth: "none",
        body: {},
      },
      usable: true,
    });

    const providers = await listProviderSettings(env, workspaceId, null);
    expect(providers.find((provider) => provider.provider === "openai-compatible")?.usable).toBe(
      true,
    );
  });

  it("rejects missing Qwen base URL and unsafe custom base URLs", async () => {
    await expect(
      saveProviderEndpointConfig(env, workspaceId, "qwen", {
        baseUrl: "",
        auth: "bearer",
        body: {},
      }),
    ).rejects.toThrow("provider_base_url_required");

    await expect(
      saveProviderEndpointConfig(env, workspaceId, "openai-compatible", {
        baseUrl: "http://example.com/v1",
        auth: "none",
        body: {},
      }),
    ).rejects.toThrow("provider_base_url_invalid");
  });

  it("persists an openai-oauth proxy route and rejects unsafe ones", async () => {
    const saved = await saveProviderEndpointConfig(env, workspaceId, "openai-oauth", {
      proxyUrl: "https://proxy.example.com/openai-oauth",
    });
    expect(saved).toMatchObject({
      provider: "openai-oauth",
      endpointConfig: {
        proxyUrl: "https://proxy.example.com/openai-oauth",
        auth: "bearer",
        body: {},
      },
      usable: false, // secret still missing
    });

    await expect(
      saveProviderEndpointConfig(env, workspaceId, "openai-oauth", {
        proxyUrl: "http://example.com/openai-oauth",
      }),
    ).rejects.toThrow("provider_proxy_url_invalid");
  });

  it("refuses a proxy route for a provider the egress proxy does not serve", async () => {
    await expect(
      saveProviderEndpointConfig(env, workspaceId, "anthropic", {
        proxyUrl: "https://proxy.example.com/anthropic",
      }),
    ).rejects.toThrow("provider_proxy_url_unsupported");
  });

  it("persists an opencode-zen proxy route alongside its own endpoint", async () => {
    const saved = await saveProviderEndpointConfig(env, workspaceId, "opencode-zen", {
      baseUrl: "https://opencode.ai/zen/v1",
      proxyUrl: "https://proxy.example.com/opencode-zen",
    });
    expect(saved.endpointConfig).toMatchObject({
      baseUrl: "https://opencode.ai/zen/v1",
      proxyUrl: "https://proxy.example.com/opencode-zen",
    });
  });

  it("marks openai-oauth usable only when both secret and proxy route are set", async () => {
    await saveProviderEndpointConfig(env, workspaceId, "openai-oauth", {
      proxyUrl: "https://proxy.example.com/openai-oauth",
    });
    const saved = await saveProviderSecret(env, workspaceId, "openai-oauth", {
      value: JSON.stringify({
        access_token: "tok",
        account_id: "acct",
        refresh_token: "ref",
      }),
    });
    expect(saved.endpointConfig.proxyUrl).toBe("https://proxy.example.com/openai-oauth");
    expect(saved.secretPresent).toBe(true);
    expect(saved.usable).toBe(true);
  });

  it("ignores unrelated corrupt workspace secrets when listing provider settings", async () => {
    const updatedAt = "2026-06-29T12:34:00.000Z";
    await upsertProviderConfig(env, workspaceId, {
      provider: "openai",
      secretName: "provider:openai",
    });
    const { writer } = createWorkspaceSecretsServices(env);
    await writer.ensureWorkspaceDek(workspaceId);
    await writer.set(workspaceId, "provider:openai", "sk-provider-secret", {
      updatedAt,
    });
    await env.SECRETS_KV.put(
      buildWorkspaceSecretKey(workspaceId, "unrelated-corrupt-secret"),
      "not-json",
    );

    const providers = await listProviderSettings(env, workspaceId, null);

    expect(providers.find((provider) => provider.provider === "openai")).toMatchObject({
      provider: "openai",
      configuredSecretName: "provider:openai",
      secretPresent: true,
      secretUpdatedAt: updatedAt,
      previewAvailable: true,
    });
  });

  it("stores encrypted provider secrets, upserts metadata, and preserves exact values", async () => {
    const value = "  anthropic-secret\n";

    const saved = await saveProviderSecret(env, workspaceId, "anthropic", {
      value,
      secretName: "  anthropic-live  ",
    });

    expect(saved).toMatchObject({
      provider: "anthropic",
      configuredSecretName: "anthropic-live",
      secretPresent: true,
      previewAvailable: true,
    });
    expect(saved.secretUpdatedAt).toEqual(expect.any(String));
    expect(JSON.stringify(saved)).not.toContain("anthropic-secret");
    await expect(getProviderConfig(env, workspaceId, "anthropic")).resolves.toMatchObject({
      provider: "anthropic",
      secretName: "anthropic-live",
    });
    const raw = await env.SECRETS_KV.get(buildWorkspaceSecretKey(workspaceId, "anthropic-live"));
    expect(raw).not.toContain("anthropic-secret");
    const { store } = createWorkspaceSecretsServices(env);
    await expect(store.get(workspaceId, "anthropic-live")).resolves.toBe(value);
  });

  it("does not write KV secret material when provider metadata persistence fails", async () => {
    const missingWorkspaceId = "ws-provider-settings-missing";
    const secretName = "provider:openai";
    await clearSecretsFor(missingWorkspaceId);
    await env.REGISTRY_DB.prepare(
      [
        "CREATE TRIGGER IF NOT EXISTS fail_missing_provider_config_insert",
        "BEFORE INSERT ON provider_configs",
        `WHEN NEW.workspace_id = '${missingWorkspaceId}'`,
        "BEGIN",
        "SELECT RAISE(ABORT, 'provider config insert failed');",
        "END",
      ].join(" "),
    ).run();

    try {
      await expect(
        saveProviderSecret(env, missingWorkspaceId, "openai", {
          value: "sk-should-not-be-written",
          secretName,
        }),
      ).rejects.toThrow();
    } finally {
      await env.REGISTRY_DB.prepare(
        "DROP TRIGGER IF EXISTS fail_missing_provider_config_insert",
      ).run();
    }

    await expect(
      env.SECRETS_KV.get(buildWorkspaceSecretKey(missingWorkspaceId, secretName)),
    ).resolves.toBeNull();
  });

  it("falls back to current or default secret names when input names are blank", async () => {
    await upsertProviderConfig(env, workspaceId, {
      provider: "openai",
      secretName: "current-openai-secret",
    });

    await expect(
      saveProviderSecret(env, workspaceId, "openai", {
        value: "openai-current-secret",
        secretName: "   ",
      }),
    ).resolves.toMatchObject({
      provider: "openai",
      configuredSecretName: "current-openai-secret",
      secretPresent: true,
    });
    await expect(
      saveProviderSecret(env, workspaceId, "openrouter", {
        value: "openrouter-default-secret",
        secretName: "",
      }),
    ).resolves.toMatchObject({
      provider: "openrouter",
      configuredSecretName: "provider:openrouter",
      secretPresent: true,
    });
  });

  it("rejects invalid secret names before writing provider metadata or KV", async () => {
    const invalidNames = [
      "provider/openai",
      "provider\\openai",
      "provider openai",
      "provider:\nopenai",
      "a".repeat(129),
    ];

    for (const secretName of invalidNames) {
      await expect(
        saveProviderSecret(env, workspaceId, "openai", {
          value: "sk-invalid-name",
          secretName,
        }),
      ).rejects.toThrow("invalid_secret_name");
    }

    await expect(getProviderConfig(env, workspaceId, "openai")).resolves.toBeUndefined();
    await expect(
      env.SECRETS_KV.list({ prefix: `workspaces/${workspaceId}/` }),
    ).resolves.toMatchObject({
      keys: [],
    });
  });

  it("rejects blank secret values", async () => {
    await expect(
      saveProviderSecret(env, workspaceId, "openai", {
        value: " \n\t ",
      }),
    ).rejects.toThrow("secret_value_required");
  });

  it("returns only clamped lazy plaintext prefixes for previews", async () => {
    await saveProviderSecret(env, workspaceId, "openrouter", {
      value: "openrouter-secret-value",
    });

    await expect(previewProviderSecret(env, workspaceId, "openrouter", 99)).resolves.toEqual({
      provider: "openrouter",
      secretName: "provider:openrouter",
      preview: "openrouter-secre",
      chars: 16,
      truncated: true,
      updatedAt: expect.any(String),
    });
    await expect(previewProviderSecret(env, workspaceId, "openrouter", 2)).resolves.toEqual({
      provider: "openrouter",
      secretName: "provider:openrouter",
      preview: "open",
      chars: 4,
      truncated: true,
      updatedAt: expect.any(String),
    });
    await expect(previewProviderSecret(env, workspaceId, "openrouter", 8)).resolves.not.toEqual(
      expect.objectContaining({ preview: "openrouter-secret-value" }),
    );

    await saveProviderSecret(env, workspaceId, "openai", {
      value: "tiny",
    });
    await expect(previewProviderSecret(env, workspaceId, "openai", 99)).resolves.toEqual({
      provider: "openai",
      secretName: "provider:openai",
      preview: "tin",
      chars: 3,
      truncated: true,
      updatedAt: expect.any(String),
    });

    await saveProviderSecret(env, workspaceId, "anthropic", {
      value: "x",
    });
    await expect(previewProviderSecret(env, workspaceId, "anthropic", 99)).resolves.toEqual({
      provider: "anthropic",
      secretName: "provider:anthropic",
      preview: "",
      chars: 0,
      truncated: true,
      updatedAt: expect.any(String),
    });
  });

  it("returns undefined preview for missing secrets", async () => {
    await expect(
      previewProviderSecret(env, workspaceId, "openai-oauth", 8),
    ).resolves.toBeUndefined();
  });

  it("preserves current provider metadata if encrypted secret persistence fails", async () => {
    await upsertProviderConfig(env, workspaceId, {
      provider: "openai",
      secretName: "provider:openai-current",
    });
    await env.SECRETS_KV.put(
      buildWorkspaceDekKey(workspaceId),
      JSON.stringify({
        wrapped_dek: "not-valid-ciphertext",
        kek_version: 1,
        created_at: "2026-06-29T00:00:00.000Z",
      }),
    );

    await expect(
      saveProviderSecret(env, workspaceId, "openai", {
        value: "sk-new-value",
        secretName: "provider:openai-new",
      }),
    ).rejects.toThrow();

    await expect(getProviderConfig(env, workspaceId, "openai")).resolves.toMatchObject({
      provider: "openai",
      secretName: "provider:openai-current",
    });
    await expect(
      env.SECRETS_KV.get(buildWorkspaceSecretKey(workspaceId, "provider:openai-new")),
    ).resolves.toBeNull();
  });

  it("restores an existing secret if provider metadata persistence fails", async () => {
    const { writer, store } = createWorkspaceSecretsServices(env);
    await writer.ensureWorkspaceDek(workspaceId);
    await writer.set(workspaceId, "provider:openai", "sk-original-value");
    await env.REGISTRY_DB.prepare(
      [
        "CREATE TRIGGER IF NOT EXISTS fail_provider_config_existing_secret_insert",
        "BEFORE INSERT ON provider_configs",
        `WHEN NEW.workspace_id = '${workspaceId}'`,
        "BEGIN",
        "SELECT RAISE(ABORT, 'provider config insert failed');",
        "END",
      ].join(" "),
    ).run();

    try {
      await expect(
        saveProviderSecret(env, workspaceId, "openai", {
          value: "sk-new-value",
          secretName: "provider:openai",
        }),
      ).rejects.toThrow();
    } finally {
      await env.REGISTRY_DB.prepare(
        "DROP TRIGGER IF EXISTS fail_provider_config_existing_secret_insert",
      ).run();
    }

    await expect(store.get(workspaceId, "provider:openai")).resolves.toBe("sk-original-value");
    await expect(getProviderConfig(env, workspaceId, "openai")).resolves.toBeUndefined();
  });

  describe("workers-ai gating", () => {
    const allowed = "you@example.com";
    const denied = "someone@else.com";
    let previous: string | undefined;

    beforeEach(() => {
      previous = env.WORKERS_AI_EMAILS;
      env.WORKERS_AI_EMAILS = "you@example.com, teammate@example.com";
    });

    afterEach(() => {
      env.WORKERS_AI_EMAILS = previous as string;
    });

    it("offers workers-ai to an allowlisted viewer, usable with no secret stored", async () => {
      const providers = await listProviderSettings(env, workspaceId, allowed);
      const entry = providers.find((p) => p.provider === "workers-ai");

      expect(entry).toBeDefined();
      // The whole point: no key, yet ready to use — it authenticates by binding.
      expect(entry?.secretPresent).toBe(false);
      expect(entry?.usable).toBe(true);
    });

    it("withholds workers-ai entirely from a non-allowlisted viewer", async () => {
      const providers = await listProviderSettings(env, workspaceId, denied);

      expect(providers.find((p) => p.provider === "workers-ai")).toBeUndefined();
      // The gate is scoped to workers-ai — every other provider still lists.
      expect(providers.find((p) => p.provider === "openai")).toBeDefined();
    });

    it("withholds workers-ai when there is no viewer email at all", async () => {
      const providers = await listProviderSettings(env, workspaceId, null);
      expect(providers.find((p) => p.provider === "workers-ai")).toBeUndefined();
    });

    it("offers workers-ai to everyone once the allowlist is cleared", async () => {
      env.WORKERS_AI_EMAILS = "";
      const providers = await listProviderSettings(env, workspaceId, denied);
      expect(providers.find((p) => p.provider === "workers-ai")).toBeDefined();
    });
  });
});
