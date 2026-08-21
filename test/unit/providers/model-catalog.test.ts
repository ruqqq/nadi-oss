import { describe, expect, it } from "vitest";
import {
  applyModelsDevProfiles,
  CATALOG_TTL_MS,
  decideCatalogAction,
} from "../../../src/providers/model-catalog";
import {
  filterProviderModels,
  loadProviderModels,
  searchProviderModels,
  type ProviderModelSearchResult,
} from "../../../src/providers/model-search";
import type { ModelsDevCatalog } from "../../../src/providers/models-dev";

const NOW = 1_800_000_000_000;

describe("decideCatalogAction", () => {
  it("fetches when nothing is cached", () => {
    expect(decideCatalogAction({ row: null, now: NOW, refresh: false })).toBe("fetch");
  });

  it("serves a row inside the TTL without touching the provider", () => {
    expect(
      decideCatalogAction({
        row: { fetchedAt: NOW - CATALOG_TTL_MS + 1 },
        now: NOW,
        refresh: false,
      }),
    ).toBe("serve-fresh");
  });

  it("treats a row exactly at the TTL as stale", () => {
    // The boundary is the whole point of a TTL; an off-by-one here means a row
    // that never expires.
    expect(
      decideCatalogAction({ row: { fetchedAt: NOW - CATALOG_TTL_MS }, now: NOW, refresh: false }),
    ).toBe("serve-stale-and-revalidate");
  });

  it("revalidates behind the response once the row is stale", () => {
    expect(
      decideCatalogAction({
        row: { fetchedAt: NOW - CATALOG_TTL_MS - 1 },
        now: NOW,
        refresh: false,
      }),
    ).toBe("serve-stale-and-revalidate");
  });

  it("awaits a forced refresh even when the row is fresh", () => {
    expect(decideCatalogAction({ row: { fetchedAt: NOW }, now: NOW, refresh: true })).toBe(
      "await-refresh",
    );
  });

  it("still fetches on a forced refresh with nothing cached", () => {
    expect(decideCatalogAction({ row: null, now: NOW, refresh: true })).toBe("fetch");
  });
});

describe("loadProviderModels", () => {
  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  it("returns the provider's whole catalog, past the search response limit", async () => {
    // MAX_LIMIT (50) bounds a *search* response. Applying it to the catalog
    // would truncate a large provider and present the result as complete.
    const data = Array.from({ length: 120 }, (_, i) => ({ id: `model-${i}` }));
    const result = await loadProviderModels({
      provider: "openrouter",
      fetchImpl: async () => jsonResponse({ data }),
      secret: "sk-test",
      endpointConfig: {
        baseUrl: "https://openrouter.ai/api/v1",
        proxyUrl: "",
        auth: "bearer",
        body: {},
      },
    });

    expect(result.source).toBe("live");
    expect(result.models).toHaveLength(120);
  });

  it("degrades to the static list when the provider call fails", async () => {
    const result = await loadProviderModels({
      provider: "openrouter",
      fetchImpl: async () => new Response("nope", { status: 500 }),
      secret: "sk-test",
      endpointConfig: {
        baseUrl: "https://openrouter.ai/api/v1",
        proxyUrl: "",
        auth: "bearer",
        body: {},
      },
    });

    expect(result.source).toBe("static");
    expect(result.models.length).toBeGreaterThan(0);
  });
});

describe("searchProviderModels", () => {
  it("still clamps its own response to the search limit", async () => {
    const data = Array.from({ length: 120 }, (_, i) => ({ id: `model-${i}` }));
    const result = await searchProviderModels({
      provider: "openrouter",
      query: "",
      limit: 500,
      fetchImpl: async () =>
        new Response(JSON.stringify({ data }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      secret: "sk-test",
      endpointConfig: {
        baseUrl: "https://openrouter.ai/api/v1",
        proxyUrl: "",
        auth: "bearer",
        body: {},
      },
    });

    expect(result.models).toHaveLength(50);
  });
});

describe("filterProviderModels", () => {
  const models: ProviderModelSearchResult[] = [
    {
      id: "anthropic/claude-opus-5",
      name: "Claude Opus 5",
      inputModalities: ["text"],
      source: "live",
    },
    { id: "openai/gpt-5.5", name: "GPT-5.5", inputModalities: ["text"], source: "live" },
    {
      id: "meta/llama-4",
      name: "Llama 4",
      description: "Open weights from Meta",
      inputModalities: ["text"],
      source: "live",
    },
  ];

  it("returns everything for an empty query", () => {
    expect(filterProviderModels(models, "  ")).toHaveLength(3);
  });

  it("matches id, name and description case-insensitively", () => {
    expect(filterProviderModels(models, "OPUS").map((m) => m.id)).toEqual([
      "anthropic/claude-opus-5",
    ]);
    expect(filterProviderModels(models, "gpt-5.5").map((m) => m.id)).toEqual(["openai/gpt-5.5"]);
    expect(filterProviderModels(models, "open weights").map((m) => m.id)).toEqual(["meta/llama-4"]);
  });
});

describe("applyModelsDevProfiles", () => {
  const catalog: ModelsDevCatalog = {
    "opencode-zen": {
      "claude-sonnet-5": {
        reasoning: true,
        controls: [],
        inputModalities: ["text", "image", "file"],
      },
      "deepseek-v4-pro": { reasoning: true, controls: [], inputModalities: ["text"] },
    },
    deepseek: {
      "deepseek-v4-flash": { reasoning: true, controls: [], inputModalities: ["text"] },
    },
  };

  it("overlays models.dev modalities onto ids-only live rows", () => {
    // OpenCode Zen / DeepSeek /models return ids with no architecture. The
    // static table then defaults those to ["text"], which is what hid image
    // attach on Claude (and would on any vision model models.dev already knows).
    const models: ProviderModelSearchResult[] = [
      { id: "claude-sonnet-5", inputModalities: ["text"], source: "live" },
      { id: "deepseek-v4-pro", inputModalities: ["text"], source: "live" },
      {
        id: "deepseek-v4-flash-vision-exp",
        inputModalities: ["text", "image"],
        source: "static",
      },
    ];

    const byId = new Map(
      applyModelsDevProfiles(models, catalog, "opencode-zen").map((model) => [model.id, model]),
    );
    expect(byId.get("claude-sonnet-5")?.inputModalities).toEqual(["text", "image", "file"]);
    expect(byId.get("deepseek-v4-pro")?.inputModalities).toEqual(["text"]);
    // models.dev has no entry yet — the static/heuristic overlay must survive.
    expect(byId.get("deepseek-v4-flash-vision-exp")?.inputModalities).toEqual(["text", "image"]);
  });

  it("leaves the list untouched when the catalog is missing", () => {
    const models: ProviderModelSearchResult[] = [
      { id: "claude-sonnet-5", inputModalities: ["text"], source: "live" },
    ];
    expect(applyModelsDevProfiles(models, null, "opencode-zen")).toEqual(models);
  });
});
