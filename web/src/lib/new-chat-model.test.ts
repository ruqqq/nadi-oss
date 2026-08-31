import { describe, expect, it } from "vitest";
import {
  canStartNewChat,
  deriveNewChatModelState,
  emptyNewChatModelState,
  selectNewChatModelModalities,
  selectNewChatProvider,
  typeNewChatModel,
} from "./new-chat-model";
import type { AgentSettingsResponse, ProviderSettingsView } from "../settings-api";

function provider(
  providerName: ProviderSettingsView["provider"],
  usable: boolean,
  whitelistModels: ProviderSettingsView["whitelistModels"] = null,
): ProviderSettingsView {
  return {
    provider: providerName,
    displayName: providerName,
    defaultSecretName: `${providerName}-key`,
    configuredSecretName: `${providerName}-key`,
    secretPresent: usable,
    secretUpdatedAt: usable ? "2026-07-01T00:00:00Z" : null,
    previewAvailable: usable,
    endpointConfig: { baseUrl: "", proxyUrl: "", auth: "bearer", body: {} },
    usable,
    whitelistModels,
  };
}

function settings(overrides: Partial<AgentSettingsResponse> = {}): AgentSettingsResponse {
  const base: AgentSettingsResponse = {
    workspace: { id: "workspace-1", name: "Workspace" },
    agent: {
      id: "agent-1",
      name: "Default",
      systemPrompt: "You are Nadi.",
      provider: "openai-oauth",
      model: "gpt-5.5",
      modelInputModalities: ["text", "image", "file"],
      reasoningEffort: "medium",
      modelSupportsReasoning: null,
    },
    providers: [provider("openai-oauth", true), provider("anthropic", false)],
  };
  return { ...base, ...overrides };
}

describe("new chat model state", () => {
  it("defaults to the usable Settings agent provider and model snapshot", () => {
    expect(deriveNewChatModelState(settings())).toMatchObject({
      providers: [expect.objectContaining({ provider: "openai-oauth" })],
      provider: "openai-oauth",
      model: "gpt-5.5",
      modelInputModalities: ["text", "image", "file"],
      reasoningEffort: "medium",
      modelSupportsReasoning: null,
    });
  });

  it("falls back to the first usable provider when the agent provider is not usable", () => {
    const state = deriveNewChatModelState(
      settings({
        agent: {
          ...settings().agent,
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          modelInputModalities: ["text", "image"],
        },
        providers: [provider("anthropic", false), provider("qwen", true)],
      }),
    );

    expect(state).toMatchObject({
      provider: "qwen",
      model: "qwen-plus",
      modelInputModalities: ["text"],
    });
    expect(state.providers.map((entry) => entry.provider)).toEqual(["qwen"]);
  });

  it("blocks new-chat sends until a usable provider and model are selected", () => {
    expect(canStartNewChat(emptyNewChatModelState())).toBe(false);
    expect(canStartNewChat({ provider: "openai-oauth", model: "   " })).toBe(false);
    expect(canStartNewChat({ provider: "openai-oauth", model: "gpt-5.5" })).toBe(true);
  });

  it("resets upload modalities when provider or model is typed manually", () => {
    const state = deriveNewChatModelState(settings());

    expect(selectNewChatProvider("qwen", state)).toMatchObject({
      provider: "qwen",
      model: "qwen-plus",
      modelInputModalities: ["text"],
    });
    expect(typeNewChatModel("qwen-vl-plus", state)).toMatchObject({
      model: "qwen-vl-plus",
      modelInputModalities: ["text"],
    });
  });

  it("uses selected model input modalities for the new-chat attachment affordance", () => {
    const state = deriveNewChatModelState(settings());

    expect(selectNewChatModelModalities(["text", "image"], state)).toMatchObject({
      modelInputModalities: ["text", "image"],
    });
  });
});

describe("deriveNewChatModelState with curated providers", () => {
  const model: NonNullable<ProviderSettingsView["whitelistModels"]>[number] = {
    id: "gpt-5.5",
    inputModalities: ["text"],
    source: "static",
  };

  it("drops a provider curated down to zero models", () => {
    const state = deriveNewChatModelState(
      settings({
        providers: [provider("openai", true, []), provider("anthropic", true, null)],
      }),
    );

    expect(state.providers.map((entry) => entry.provider)).toEqual(["anthropic"]);
  });

  it("keeps a provider whose curated list still has something in it", () => {
    const state = deriveNewChatModelState(
      settings({ providers: [provider("openai", true, [{ ...model }])] }),
    );

    expect(state.providers.map((entry) => entry.provider)).toEqual(["openai"]);
  });

  it("never starts a new chat on a provider curated to zero, even the agent default", () => {
    // Falling back to a provider with an empty picker would open a chat the
    // user cannot pick a model for.
    const state = deriveNewChatModelState(
      settings({
        agent: {
          id: "agent-1",
          name: "Default",
          systemPrompt: "You are Nadi.",
          provider: "openai",
          model: "gpt-5.5",
          modelInputModalities: ["text"],
          reasoningEffort: "medium",
          modelSupportsReasoning: null,
        },
        providers: [provider("openai", true, []), provider("anthropic", true, null)],
      }),
    );

    expect(state.provider).toBe("anthropic");
  });

  it("reports whether any provider was usable before curation dropped them", () => {
    // `providers: []` has two causes with different fixes; the empty state has
    // to tell them apart.
    const curatedOff = deriveNewChatModelState(
      settings({ providers: [provider("openai", true, [])] }),
    );
    expect(curatedOff.providers).toHaveLength(0);
    expect(curatedOff.anyUsableProvider).toBe(true);

    const noKeys = deriveNewChatModelState(
      settings({ providers: [provider("openai", false, null)] }),
    );
    expect(noKeys.providers).toHaveLength(0);
    expect(noKeys.anyUsableProvider).toBe(false);
  });
});

describe("openai-compatible has no default model", () => {
  it("leaves the model empty rather than pre-filling the hint string", () => {
    // Its placeholder is the literal "model-id" — a prompt, not a model. Writing
    // it into the value made the composer look ready to send a model id no
    // provider serves.
    const state = selectNewChatProvider("openai-compatible", emptyNewChatModelState());
    expect(state.model).toBe("");
    expect(canStartNewChat(state)).toBe(false);
  });

  it("still pre-fills a real default for providers that have one", () => {
    const state = selectNewChatProvider("anthropic", emptyNewChatModelState());
    expect(state.model).not.toBe("");
    expect(canStartNewChat(state)).toBe(true);
  });
});
