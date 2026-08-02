import { describe, expect, it, vi } from "vitest";
import {
  getStaticProviderModels,
  normalizeModelSearchLimit,
  searchProviderModels,
} from "../../../src/providers/model-search";

describe("model-search", () => {
  it("filters static models by id and name with a bounded limit", async () => {
    const result = await searchProviderModels({
      provider: "zai",
      query: "5.2",
      limit: 3,
      fetchImpl: vi.fn(),
      secret: null,
      endpointConfig: {
        baseUrl: "https://api.z.ai/api/paas/v4",
        proxyUrl: "",
        auth: "bearer",
        body: {},
      },
    });

    expect(result.source).toBe("static");
    expect(result.models.map((model) => model.id)).toContain("glm-5.2");
    expect(result.models.length).toBeLessThanOrEqual(3);
    expect(result.models[0]?.inputModalities).toEqual(["text"]);
  });

  it("normalizes invalid limits to the default and caps large limits", () => {
    expect(normalizeModelSearchLimit(null)).toBe(20);
    expect(normalizeModelSearchLimit("0")).toBe(20);
    expect(normalizeModelSearchLimit("500")).toBe(50);
    expect(normalizeModelSearchLimit("7")).toBe(7);
  });

  it("keeps curated model metadata available without a live provider", () => {
    const openrouter = getStaticProviderModels("openrouter");
    expect(openrouter.find((model) => model.id === "openai/gpt-5.4-mini")).toMatchObject({
      inputModalities: ["text"],
      source: "static",
    });

    const openaiOauth = getStaticProviderModels("openai-oauth");
    expect(openaiOauth.map((model) => model.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4-mini",
      "gpt-5.4",
      "gpt-5.3-codex-spark",
    ]);
    expect(openaiOauth.slice(0, 3)).toEqual([
      expect.objectContaining({
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        contextLength: 272000,
        inputModalities: ["text", "image", "file"],
      }),
      expect.objectContaining({
        id: "gpt-5.6-terra",
        name: "GPT-5.6 Terra",
        contextLength: 272000,
        inputModalities: ["text", "image", "file"],
      }),
      expect.objectContaining({
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        contextLength: 272000,
        inputModalities: ["text", "image", "file"],
      }),
    ]);

    const qwen = getStaticProviderModels("qwen");
    expect(qwen.map((model) => model.id)).toEqual(
      expect.arrayContaining(["qwen3.7-max", "qwen3.7-plus", "qwen3.6-flash"]),
    );

    const opencodeGo = getStaticProviderModels("opencode-go");
    expect(opencodeGo.map((model) => model.id)).toEqual(
      expect.arrayContaining(["glm-5.2", "kimi-k2.7-code", "deepseek-v4-flash"]),
    );
    expect(opencodeGo.find((model) => model.id === "glm-5.2")).toMatchObject({
      name: "GLM-5.2",
      contextLength: 1000000,
      inputModalities: ["text"],
    });
  });

  it("normalizes OpenRouter live models with input modalities", async () => {
    const fetchImpl = vi.fn(async () => {
      return Response.json({
        data: [
          {
            id: "openai/gpt-5.4-mini",
            name: "GPT-5.4 mini",
            context_length: 400000,
            architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
          },
          {
            id: "z-ai/glm-5.2",
            name: "GLM 5.2",
            context_length: 1000000,
            architecture: { input_modalities: ["text"], output_modalities: ["text"] },
          },
          {
            id: "image/generator",
            name: "Image Generator",
            context_length: 32000,
            architecture: { input_modalities: ["text"], output_modalities: ["image"] },
          },
        ],
      });
    });

    const result = await searchProviderModels({
      provider: "openrouter",
      query: "gpt",
      limit: 20,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      secret: "sk-or-test",
      endpointConfig: {
        baseUrl: "https://openrouter.ai/api/v1",
        proxyUrl: "",
        auth: "bearer",
        body: {},
      },
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer sk-or-test" }),
      }),
    );
    expect(result.source).toBe("live");
    expect(result.models).toEqual([
      {
        id: "openai/gpt-5.4-mini",
        name: "GPT-5.4 mini",
        contextLength: 400000,
        inputModalities: ["text", "image"],
        outputModalities: ["text"],
        // This fixture publishes no `supported_parameters`, so the static
        // table's value fills in — the same fallback that gives OpenAI,
        // Anthropic and DeepSeek a capability at all, since their /models
        // endpoints return ids only.
        reasoning: true,
        source: "live",
      },
    ]);
  });

  it("reads reasoning capability from supported_parameters, live answer winning", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        data: [
          {
            // In the static table as reasoning: true — the live "no" must win,
            // or a model that stopped reasoning would keep claiming it does.
            id: "openai/gpt-5.4-mini",
            architecture: { input_modalities: ["text"], output_modalities: ["text"] },
            supported_parameters: ["temperature", "tools"],
          },
          {
            id: "brand/new-thinker",
            architecture: { input_modalities: ["text"], output_modalities: ["text"] },
            supported_parameters: ["reasoning", "tools"],
          },
          {
            // No supported_parameters and not in the static table: UNKNOWN.
            // Must stay absent rather than defaulting to false, which would
            // assert the model cannot think.
            id: "brand/unknown",
            architecture: { input_modalities: ["text"], output_modalities: ["text"] },
          },
        ],
      }),
    );

    const result = await searchProviderModels({
      provider: "openrouter",
      query: "",
      limit: 20,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      secret: "sk-or-test",
      endpointConfig: {
        baseUrl: "https://openrouter.ai/api/v1",
        proxyUrl: "",
        auth: "bearer",
        body: {},
      },
    });

    const byId = new Map(result.models.map((model) => [model.id, model]));
    expect(byId.get("openai/gpt-5.4-mini")?.reasoning).toBe(false);
    expect(byId.get("brand/new-thinker")?.reasoning).toBe(true);
    expect(byId.get("brand/unknown")).not.toHaveProperty("reasoning");
  });

  it("filters live models that cannot output text", async () => {
    const fetchImpl = vi.fn(async () => {
      return Response.json({
        data: [
          {
            id: "image/generator",
            name: "Image Generator",
            architecture: { input_modalities: ["text"], output_modalities: ["image"] },
          },
          {
            id: "openai/gpt-5.4-mini",
            name: "GPT-5.4 mini",
            architecture: { input_modalities: ["text"], output_modalities: ["text"] },
          },
          {
            id: "unknown-output/model",
            name: "Unknown output model",
            architecture: { input_modalities: ["text"] },
          },
        ],
      });
    });

    const result = await searchProviderModels({
      provider: "openrouter",
      query: "",
      limit: 20,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      secret: "sk-or-test",
      endpointConfig: {
        baseUrl: "https://openrouter.ai/api/v1",
        proxyUrl: "",
        auth: "bearer",
        body: {},
      },
    });

    expect(result.models.map((model) => model.id)).toEqual([
      "openai/gpt-5.4-mini",
      "unknown-output/model",
    ]);
  });

  it("falls back to static models when live lookup fails", async () => {
    const result = await searchProviderModels({
      provider: "deepseek",
      query: "v4",
      limit: 20,
      fetchImpl: vi.fn(
        async () => new Response("bad gateway", { status: 502 }),
      ) as unknown as typeof fetch,
      secret: "sk-test",
      endpointConfig: {
        baseUrl: "https://api.deepseek.com",
        proxyUrl: "",
        auth: "bearer",
        body: {},
      },
    });

    expect(result.source).toBe("static");
    expect(result.models.map((model) => model.id)).toEqual(
      expect.arrayContaining(["deepseek-v4-pro", "deepseek-v4-flash"]),
    );
  });

  it("lists OpenCode Go live models from its OpenAI-compatible endpoint", async () => {
    const fetchImpl = vi.fn(async () => {
      return Response.json({
        data: [{ id: "glm-5.2" }, { id: "kimi-k2.7-code" }, { id: "deepseek-v4-flash" }],
      });
    });

    const result = await searchProviderModels({
      provider: "opencode-go",
      query: "kimi",
      limit: 20,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      secret: "ocgo-test",
      endpointConfig: {
        baseUrl: "https://opencode.ai/zen/go/v1",
        proxyUrl: "",
        auth: "bearer",
        body: {},
      },
    });

    expect(fetchImpl).toHaveBeenCalledWith("https://opencode.ai/zen/go/v1/models", {
      headers: { Accept: "application/json", Authorization: "Bearer ocgo-test" },
    });
    expect(result.source).toBe("live");
    expect(result.models).toEqual([
      expect.objectContaining({
        id: "kimi-k2.7-code",
        name: "Kimi K2.7 Code",
        inputModalities: ["text"],
      }),
    ]);
  });
});

describe("curated model catalog", () => {
  it("gives every curated anthropic model a context window", () => {
    for (const model of getStaticProviderModels("anthropic")) {
      expect(model.contextLength, `${model.id} has no contextLength`).toBeGreaterThan(0);
    }
  });

  it("never claims a context window it cannot honor", () => {
    // A too-large window overflows the provider and hard-fails the turn; a
    // too-small one merely compacts early. Nothing should exceed 2M.
    for (const provider of [
      "openai",
      "anthropic",
      "openrouter",
      "deepseek",
      "zai",
      "qwen",
    ] as const) {
      for (const model of getStaticProviderModels(provider)) {
        if (model.contextLength !== undefined) {
          expect(model.contextLength).toBeGreaterThan(0);
          expect(model.contextLength).toBeLessThanOrEqual(2_000_000);
        }
      }
    }
  });
});
