import { streamText } from "ai";
import { describe, expect, it } from "vitest";
import { OpenAIOAuthAuthManager } from "../../../src/providers/openai-oauth/auth";
import { buildModel } from "../../../src/providers/model-factory";

describe("buildModel", () => {
  it("returns a deterministic mock model that echoes the last user message", async () => {
    const model = buildModel({ provider: "mock", model: "mock", apiKey: "" });
    const result = streamText({ model, prompt: "Hello" });
    let text = "";
    for await (const delta of result.textStream) text += delta;
    expect(text).toBe("Echo: Hello");
  });

  it("throws for an unsupported provider", () => {
    expect(() => buildModel({ provider: "nope", model: "x", apiKey: "k" })).toThrow(
      "unsupported_provider",
    );
  });

  it("requires explicit OAuth options for openai-oauth", () => {
    expect(() =>
      buildModel({ provider: "openai-oauth", model: "gpt-5.4-mini", apiKey: "" }),
    ).toThrow("openai_oauth_options_required");
  });

  it("requires the AI binding for workers-ai", () => {
    expect(() =>
      buildModel({ provider: "workers-ai", model: "@cf/moonshotai/kimi-k2.7-code", apiKey: "" }),
    ).toThrow("workers_ai_binding_required");
  });

  it("builds a workers-ai model from the binding rather than an API key", () => {
    const binding = { run: async () => ({}) } as unknown as Ai;
    const model = buildModel({
      provider: "workers-ai",
      model: "@cf/moonshotai/kimi-k2.7-code",
      apiKey: "",
      workersAI: { binding },
    });

    const built = model as { modelId: string; specificationVersion: string };
    expect(built.modelId).toBe("@cf/moonshotai/kimi-k2.7-code");
    // The AI SDK talks to this through the LanguageModelV3 contract; if the
    // package ever regresses off that spec, streamText would fail at runtime
    // rather than here.
    expect(built.specificationVersion).toBe("v3");
  });

  it("returns an OpenAI OAuth responses model when OAuth options are provided", () => {
    const auth = new OpenAIOAuthAuthManager({
      load: async () => '{"access_token":"token","account_id":"account"}',
      save: async () => {},
    });

    const model = buildModel({
      provider: "openai-oauth",
      model: "gpt-5.4-mini",
      apiKey: "",
      openaiOAuth: { auth },
    });

    expect((model as { provider: string }).provider).toBe("openai-oauth.responses");
  });

  it("returns OpenAI-compatible chat models for configured providers", () => {
    const model = buildModel({
      provider: "opencode-go",
      model: "kimi-k2.7-code",
      apiKey: "ocgo-key",
      openAICompatible: {
        endpointConfig: {
          baseUrl: "https://opencode.ai/zen/go/v1",
          proxyUrl: "",
          auth: "bearer",
          body: {},
        },
      },
    });

    expect((model as { provider: string }).provider).toBe("opencode-go.chat");
  });

  it("requires OpenAI-compatible options for compatible providers", () => {
    expect(() =>
      buildModel({ provider: "deepseek", model: "deepseek-v4-pro", apiKey: "sk" }),
    ).toThrow("openai_compatible_options_required:deepseek");
  });
});
