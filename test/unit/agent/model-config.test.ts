import { describe, expect, it } from "vitest";
import {
  providerUsesWorkspaceSecret,
  resolveAgentModelConfig,
  resolveModelConfig,
} from "../../../src/agent/model-config";
import type { Env } from "../../../src/env";

describe("resolveModelConfig", () => {
  it("allows openai-oauth without an API key env var", () => {
    const cfg = resolveModelConfig({
      DEFAULT_MODEL_PROVIDER: "openai-oauth",
      DEFAULT_MODEL: "gpt-5.4-mini",
    } as unknown as Env);

    expect(cfg).toMatchObject({
      provider: "openai-oauth",
      model: "gpt-5.4-mini",
      apiKey: "",
      modelInputModalities: ["text"],
    });
  });

  it("does not read worker-level API keys for hosted providers", () => {
    const cfg = resolveModelConfig({
      DEFAULT_MODEL_PROVIDER: "openrouter",
      DEFAULT_MODEL: "openai/gpt-5.4-mini",
      OPENROUTER_API_KEY: "worker-level-key",
    } as unknown as Env);

    expect(cfg).toMatchObject({
      provider: "openrouter",
      model: "openai/gpt-5.4-mini",
      apiKey: "",
      modelInputModalities: ["text"],
    });
  });

  it("accepts OpenAI-compatible providers as workspace-secret providers", () => {
    expect(
      resolveModelConfig({
        DEFAULT_MODEL_PROVIDER: "deepseek",
        DEFAULT_MODEL: "deepseek-v4-pro",
      } as unknown as Env),
    ).toMatchObject({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      apiKey: "",
      modelInputModalities: ["text"],
    });

    expect(providerUsesWorkspaceSecret("deepseek")).toBe(true);
    expect(providerUsesWorkspaceSecret("zai")).toBe(true);
    expect(providerUsesWorkspaceSecret("qwen")).toBe(true);
    expect(providerUsesWorkspaceSecret("opencode-go")).toBe(true);
    expect(providerUsesWorkspaceSecret("openai-compatible")).toBe(true);
  });

  it("rejects unknown providers with the supported provider list", () => {
    expect(() =>
      resolveModelConfig({
        DEFAULT_MODEL_PROVIDER: "unknown",
        DEFAULT_MODEL: "model",
      } as unknown as Env),
    ).toThrow(/openai-oauth/);
  });

  it("resolves provider, model, and system prompt from a registered agent", () => {
    const cfg = resolveAgentModelConfig({
      provider: "openai-oauth",
      model: "gpt-5.4-mini",
      systemPrompt: "Use the workspace prompt.",
      modelInputModalities: '["text","image","file"]',
      showReasoning: true,
      reasoningEffort: "medium",
      modelSupportsReasoning: null,
    });

    expect(cfg).toEqual({
      provider: "openai-oauth",
      model: "gpt-5.4-mini",
      apiKey: "",
      systemPrompt: "Use the workspace prompt.",
      modelInputModalities: ["text", "image", "file"],
      showReasoning: true,
      reasoningEffort: "medium",
      // The column stores NULL for unknown; the resolved config normalizes that
      // to `undefined`, which is what the provider-options builder reads.
      modelSupportsReasoning: undefined,
    });
  });

  it("points invalid registered agent providers at the agents table", () => {
    expect(() =>
      resolveAgentModelConfig({
        provider: "unknown",
        model: "model",
        systemPrompt: "Prompt",
        modelInputModalities: '["text"]',
        showReasoning: true,
        reasoningEffort: "medium",
        modelSupportsReasoning: null,
      }),
    ).toThrow(/agents\.provider/);
  });
});

describe("resolveAgentModelConfig showReasoning", () => {
  it("carries showReasoning through from the agent row", () => {
    const cfg = resolveAgentModelConfig({
      provider: "mock",
      model: "mock",
      systemPrompt: "You are Nadi.",
      modelInputModalities: '["text"]',
      showReasoning: false,
      reasoningEffort: "medium",
      modelSupportsReasoning: null,
    });
    expect(cfg.showReasoning).toBe(false);
  });

  it("accepts the mock-reasoning provider", () => {
    const cfg = resolveAgentModelConfig({
      provider: "mock-reasoning",
      model: "mock-reasoning",
      systemPrompt: "You are Nadi.",
      modelInputModalities: '["text"]',
      showReasoning: true,
      reasoningEffort: "medium",
      modelSupportsReasoning: null,
    });
    expect(cfg.provider).toBe("mock-reasoning");
    expect(cfg.showReasoning).toBe(true);
  });
});
