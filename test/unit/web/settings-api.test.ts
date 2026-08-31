import { describe, expect, it, vi } from "vitest";
import {
  buildDefaultAgentSettingsSaveInput,
  getDefaultAgentSettings,
  getPrivacySettings,
  previewProviderSecret,
  saveDefaultAgentSettings,
  savePrivacySettings,
  saveProviderConfig,
  saveProviderSecret,
  searchProviderModels,
  verifyProviderSecret,
  type AgentSettingsResponse,
  type ProviderEndpointConfig,
  type ProviderSecretPreview,
  type SettingsProvider,
} from "../../../web/src/settings-api";

type SaveDefaultAgentSettingsInput = Parameters<typeof saveDefaultAgentSettings>[0];

const devProviderInput: SaveDefaultAgentSettingsInput = {
  agent: { systemPrompt: "Prompt", provider: "mock-tool-call", model: "mock-model" },
};

// @ts-expect-error agent is required in the settings save request.
const missingAgentInput: SaveDefaultAgentSettingsInput = {};
void missingAgentInput;

const unsupportedProviderConfigInput: SaveDefaultAgentSettingsInput = {
  agent: { model: "gpt-5.4-mini" },
  // @ts-expect-error providerConfig is not supported by this helper.
  providerConfig: { provider: "openai", secretName: "provider:openai" },
};
void unsupportedProviderConfigInput;

const settingsResponse: AgentSettingsResponse = {
  workspace: { id: "ws-1", name: "Workspace" },
  agent: {
    id: "agent-1",
    name: "Default",
    systemPrompt: "Prompt",
    provider: "openai",
      model: "gpt-5.4-mini",
      modelInputModalities: ["text"],
      reasoningEffort: "medium" as const,
      modelSupportsReasoning: null,
  },
  providers: [
    {
      provider: "openai",
      displayName: "OpenAI",
      defaultSecretName: "provider:openai",
      configuredSecretName: "provider:openai",
      secretPresent: true,
      secretUpdatedAt: "2026-06-29T00:00:00.000Z",
      previewAvailable: true,
      endpointConfig: {
        baseUrl: "", proxyUrl: "",
        auth: "bearer",
        body: {},
      },
      usable: true,
    },
  ],
};

describe("settings api helpers", () => {
  it("loads default agent settings", async () => {
    const fetch = vi.fn(async () => Response.json(settingsResponse));

    await expect(getDefaultAgentSettings(fetch)).resolves.toEqual(settingsResponse);

    expect(fetch).toHaveBeenCalledWith("/api/settings/agents/default", {
      credentials: "include",
    });
  });

  it("loads privacy settings", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ workspaceId: "ws1", telemetryEnabled: false }),
    );

    await expect(getPrivacySettings({ workspaceId: "ws1" }, fetch)).resolves.toEqual({
      workspaceId: "ws1",
      telemetryEnabled: false,
    });

    expect(fetch).toHaveBeenCalledWith("/api/settings/privacy?workspaceId=ws1", {
      credentials: "include",
    });
  });

  it("saves privacy settings", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ workspaceId: "ws1", telemetryEnabled: true }),
    );

    await expect(savePrivacySettings({ telemetryEnabled: true }, fetch)).resolves.toEqual({
      workspaceId: "ws1",
      telemetryEnabled: true,
    });

    expect(fetch).toHaveBeenCalledWith("/api/settings/privacy", {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ telemetryEnabled: true }),
    });
  });

  it("searches provider models with encoded query and limit", async () => {
    const fetch = vi.fn(async () => {
      return Response.json({
        provider: "openrouter",
        query: "gpt 5",
        source: "live",
        models: [{ id: "openai/gpt-5.4-mini", inputModalities: ["text"], source: "live" }],
      });
    });

    const result = await searchProviderModels(
      "openrouter",
      { query: "gpt 5", limit: 12 },
      fetch as unknown as typeof globalThis.fetch,
    );

    expect(fetch).toHaveBeenCalledWith(
      "/api/settings/providers/openrouter/models/search?q=gpt+5&limit=12",
      { credentials: "include" },
    );
    expect(result.models[0]?.id).toBe("openai/gpt-5.4-mini");
  });

  it("saves default agent settings", async () => {
    const fetch = vi.fn(async () => Response.json(settingsResponse));

    await expect(saveDefaultAgentSettings(devProviderInput, fetch)).resolves.toEqual(
      settingsResponse,
    );

    expect(fetch).toHaveBeenCalledWith("/api/settings/agents/default", {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(devProviderInput),
    });
  });

  it("omits unchanged unknown providers from default agent saves", () => {
    expect(
      buildDefaultAgentSettingsSaveInput({
        systemPrompt: "Prompt",
        model: "mock-model",
        currentProvider: "future-provider",
        selectedProvider: "openai",
        providerChanged: false,
        reasoningEffort: "medium" as const,
        modelSupportsReasoning: null,
      }),
    ).toEqual({
      agent: {
        systemPrompt: "Prompt",
        model: "mock-model",
        modelInputModalities: ["text"],
        reasoningEffort: "medium" as const,
        modelSupportsReasoning: null,
      },
    });

    expect(
      buildDefaultAgentSettingsSaveInput({
        systemPrompt: "Prompt",
        model: "gpt-5.4-mini",
        currentProvider: "future-provider",
        selectedProvider: "anthropic",
        providerChanged: true,
        reasoningEffort: "medium" as const,
        modelSupportsReasoning: null,
      }),
    ).toEqual({
      agent: {
        systemPrompt: "Prompt",
        provider: "anthropic",
        model: "gpt-5.4-mini",
        modelInputModalities: ["text"],
        reasoningEffort: "medium" as const,
        modelSupportsReasoning: null,
      },
    });
  });

  it("saves provider secrets with encoded provider ids", async () => {
    const provider = settingsResponse.providers[0];
    const fetch = vi.fn(async () => Response.json(provider));
    const encodedProvider = "openai/oauth" as SettingsProvider;

    await expect(
      saveProviderSecret(
        encodedProvider,
        { value: "secret", secretName: "provider:openai" },
        fetch,
      ),
    ).resolves.toEqual(provider);

    expect(fetch).toHaveBeenCalledWith("/api/settings/providers/openai%2Foauth/secret", {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "secret", secretName: "provider:openai" }),
    });
  });

  it("saves provider endpoint config with encoded provider ids", async () => {
    const provider = {
      provider: "qwen" as const,
      displayName: "Qwen / DashScope",
      defaultSecretName: "provider:qwen",
      configuredSecretName: "provider:qwen",
      secretPresent: false,
      secretUpdatedAt: null,
      previewAvailable: false,
      usable: false,
      endpointConfig: {
        baseUrl: "https://dashscope-us.aliyuncs.com/compatible-mode/v1", proxyUrl: "",
        auth: "bearer" as const,
        body: { enable_thinking: true },
      },
    };
    const fetch = vi.fn(async () => Response.json(provider));

    await expect(
      saveProviderConfig(
        "qwen",
        {
          baseUrl: "https://dashscope-us.aliyuncs.com/compatible-mode/v1", proxyUrl: "",
          auth: "bearer",
          body: { enable_thinking: true },
        },
        fetch,
      ),
    ).resolves.toEqual(provider);

    expect(fetch).toHaveBeenCalledWith("/api/settings/providers/qwen/config", {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl: "https://dashscope-us.aliyuncs.com/compatible-mode/v1", proxyUrl: "",
        auth: "bearer",
        body: { enable_thinking: true },
      }),
    });
  });

  it("verifies a provider key without storing it", async () => {
    const verification = { reason: "valid" as const, valid: true };
    const fetch = vi.fn(async () => Response.json(verification));

    await expect(verifyProviderSecret("openai", { value: "sk-test" }, fetch)).resolves.toEqual(
      verification,
    );

    expect(fetch).toHaveBeenCalledWith("/api/settings/providers/openai/verify", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "sk-test" }),
    });
  });

  it("passes endpoint config when verifying provider keys", async () => {
    const endpointConfig: ProviderEndpointConfig = {
      baseUrl: "https://api.deepseek.com", proxyUrl: "",
      auth: "bearer",
      body: {},
    };
    const verification = { reason: "valid" as const, valid: true };
    const fetch = vi.fn(async () => Response.json(verification));

    await expect(
      verifyProviderSecret("deepseek", { value: "sk-test", endpointConfig }, fetch),
    ).resolves.toEqual(verification);

    expect(fetch).toHaveBeenCalledWith("/api/settings/providers/deepseek/verify", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "sk-test", endpointConfig }),
    });
  });

  it("previews provider secret prefixes lazily", async () => {
    const preview: ProviderSecretPreview = {
      provider: "openai",
      secretName: "provider:openai",
      preview: "sk-proj-",
      chars: 8,
      truncated: true,
      updatedAt: "2026-06-29T00:00:00.000Z",
    };
    const fetch = vi.fn(async () => Response.json(preview));

    await expect(previewProviderSecret("openai", { chars: 8 }, fetch)).resolves.toEqual(preview);

    expect(fetch).toHaveBeenCalledWith("/api/settings/providers/openai/secret-preview", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chars: 8 }),
    });
  });

  it("encodes provider ids when previewing secret prefixes", async () => {
    const preview: ProviderSecretPreview = {
      provider: "openai-oauth",
      secretName: "provider:openai-oauth",
      preview: "oauth-",
      chars: 6,
      truncated: true,
      updatedAt: "2026-06-29T00:00:00.000Z",
    };
    const fetch = vi.fn(async () => Response.json(preview));
    const encodedProvider = "openai/oauth" as SettingsProvider;

    await previewProviderSecret(encodedProvider, { chars: 6 }, fetch);

    expect(fetch).toHaveBeenCalledWith("/api/settings/providers/openai%2Foauth/secret-preview", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chars: 6 }),
    });
  });

  it("builds the default agent save input without a showReasoning member", () => {
    expect(
      buildDefaultAgentSettingsSaveInput({
        systemPrompt: "Prompt",
        model: "gpt-5.4-mini",
        currentProvider: "openai",
        selectedProvider: "openai",
        providerChanged: false,
        reasoningEffort: "medium" as const,
      }),
    ).toEqual({
      agent: {
        systemPrompt: "Prompt",
        model: "gpt-5.4-mini",
        provider: "openai",
        modelInputModalities: ["text"],
        reasoningEffort: "medium" as const,
      },
    });
  });

  it("throws human-readable errors for non-ok responses", async () => {
    await expect(
      getDefaultAgentSettings(vi.fn(async () => new Response("", { status: 401 }))),
    ).rejects.toThrow("Your session expired. Refresh the page and sign in again.");
    await expect(
      saveDefaultAgentSettings(
        { agent: { model: "gpt-5.4-mini" } },
        vi.fn(async () => new Response("", { status: 400 })),
      ),
    ).rejects.toThrow("Couldn't save agent settings. Please try again.");
    await expect(
      saveProviderSecret(
        "anthropic",
        { value: "secret" },
        vi.fn(async () => new Response("", { status: 403 })),
      ),
    ).rejects.toThrow("You don't have permission to save provider secret.");
    await expect(
      previewProviderSecret(
        "openai",
        {},
        vi.fn(async () => new Response("Key looks invalid", { status: 400 })),
      ),
    ).rejects.toThrow("Key looks invalid");
  });
});
