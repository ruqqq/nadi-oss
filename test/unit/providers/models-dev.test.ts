import { describe, expect, it, vi } from "vitest";
import {
  fetchModelsDevCatalog,
  findModelProfile,
  MODELS_DEV_PROVIDER_IDS,
  parseModelsDevPayload,
} from "../../../src/providers/models-dev";

/** A slice of the real payload shape (verified against models.dev 2026-08-01). */
const PAYLOAD = {
  anthropic: {
    models: {
      "claude-opus-4-8": {
        id: "claude-opus-4-8",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "max"] }],
      },
      "claude-sonnet-5": { id: "claude-sonnet-5", reasoning: true, reasoning_options: [] },
    },
  },
  zhipuai: {
    models: {
      "glm-5.1": { id: "glm-5.1", reasoning: true, reasoning_options: [{ type: "toggle" }] },
    },
  },
  "opencode-go": {
    models: {
      "kimi-k2.6": { id: "kimi-k2.6", reasoning: true, reasoning_options: [] },
      "not-a-thinker": { id: "not-a-thinker", reasoning: false },
    },
  },
  // Present upstream but not one of ours — must be pruned away.
  "some-other-gateway": { models: { whatever: { id: "whatever", reasoning: true } } },
};

describe("parseModelsDevPayload", () => {
  it("prunes to our providers and maps their ids", () => {
    const catalog = parseModelsDevPayload(PAYLOAD);
    expect(Object.keys(catalog).sort()).toEqual(["anthropic", "opencode-go", "zai"]);
    // zhipuai is upstream's name for what we call zai.
    expect(catalog.zai?.["glm-5.1"]?.controls).toEqual([{ type: "toggle" }]);
    expect(catalog["some-other-gateway"]).toBeUndefined();
  });

  it("keeps an empty control list distinct from a missing one", () => {
    const catalog = parseModelsDevPayload(PAYLOAD);
    // "reasons but exposes no knob" — we must send nothing, not guess.
    expect(catalog.anthropic?.["claude-sonnet-5"]).toEqual({ reasoning: true, controls: [] });
    // A model with no reasoning_options key at all also lands on [].
    expect(catalog["opencode-go"]?.["not-a-thinker"]).toEqual({ reasoning: false, controls: [] });
  });

  it("reads input modalities and maps pdf onto file", () => {
    // models.dev publishes `modalities.input` for every provider, including the
    // ones whose own /models is ids-only (DeepSeek, OpenCode Go/Zen). Hardcoding
    // those in STATIC_MODELS is what drifted the moment a vision model shipped.
    const catalog = parseModelsDevPayload({
      anthropic: {
        models: {
          "claude-sonnet-5": {
            id: "claude-sonnet-5",
            reasoning: true,
            modalities: { input: ["text", "image", "pdf"], output: ["text"] },
          },
        },
      },
      "opencode-go": {
        models: {
          "kimi-k2.7-code": {
            id: "kimi-k2.7-code",
            reasoning: true,
            modalities: { input: ["text", "image", "video"], output: ["text"] },
          },
          "glm-5.2": {
            id: "glm-5.2",
            reasoning: true,
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      },
    });
    expect(catalog.anthropic?.["claude-sonnet-5"]?.inputModalities).toEqual([
      "text",
      "image",
      "file",
    ]);
    expect(catalog["opencode-go"]?.["kimi-k2.7-code"]?.inputModalities).toEqual([
      "text",
      "image",
      "video",
    ]);
    expect(catalog["opencode-go"]?.["glm-5.2"]?.inputModalities).toEqual(["text"]);
  });

  it("drops an effort control that declares no values", () => {
    // It would tell us nothing actionable, and an empty values array would make
    // the level mapper return null for every level.
    const catalog = parseModelsDevPayload({
      anthropic: {
        models: { m: { id: "m", reasoning: true, reasoning_options: [{ type: "effort" }] } },
      },
    });
    expect(catalog.anthropic?.m?.controls).toEqual([]);
  });

  it("survives a malformed payload rather than throwing", () => {
    expect(parseModelsDevPayload(null)).toEqual({});
    expect(parseModelsDevPayload("nope")).toEqual({});
    expect(parseModelsDevPayload({ anthropic: { models: "bad" } })).toEqual({});
  });
});

describe("findModelProfile", () => {
  const catalog = parseModelsDevPayload(PAYLOAD);

  it("matches exactly, then by bare id, then by longest prefix", () => {
    expect(findModelProfile(catalog, "anthropic", "claude-opus-4-8")?.reasoning).toBe(true);
    // Gateways prefix the vendor; the model is the same model.
    expect(findModelProfile(catalog, "anthropic", "vendor/claude-opus-4-8")?.reasoning).toBe(true);
    // A dated release resolves to its family entry.
    expect(findModelProfile(catalog, "anthropic", "claude-opus-4-8-20260630")?.reasoning).toBe(
      true,
    );
  });

  it("returns null for an unknown model or provider", () => {
    expect(findModelProfile(catalog, "anthropic", "gpt-4")).toBeNull();
    expect(findModelProfile(catalog, "openai-compatible", "anything")).toBeNull();
  });
});

describe("fetchModelsDevCatalog", () => {
  it("returns null on a bad response instead of caching an empty catalog", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 503 }));
    expect(await fetchModelsDevCatalog(fetchImpl as unknown as typeof fetch)).toBeNull();
  });

  it("returns null when the fetch throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    expect(await fetchModelsDevCatalog(fetchImpl as unknown as typeof fetch)).toBeNull();
  });

  it("calls fetch detached, not as a method", async () => {
    // Workers throws "Illegal invocation" when native fetch gets the wrong
    // `this` — the bug that silently degraded every provider model list.
    let thisArg: unknown = "untouched";
    const fetchImpl = function (this: unknown) {
      thisArg = this;
      return Promise.resolve(Response.json(PAYLOAD));
    };
    await fetchModelsDevCatalog(fetchImpl as unknown as typeof fetch);
    expect(thisArg).toBeUndefined();
  });
});

describe("provider id map", () => {
  it("points every mapped provider at a real upstream id", () => {
    expect(MODELS_DEV_PROVIDER_IDS["zai"]).toBe("zhipuai");
    expect(MODELS_DEV_PROVIDER_IDS["qwen"]).toBe("alibaba");
    expect(MODELS_DEV_PROVIDER_IDS["opencode-zen"]).toBe("opencode");
    // Same model ids, different auth path.
    expect(MODELS_DEV_PROVIDER_IDS["openai-oauth"]).toBe("openai");
    expect(MODELS_DEV_PROVIDER_IDS["openai-compatible"]).toBeUndefined();
  });
});
