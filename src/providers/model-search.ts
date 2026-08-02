import type {
  ProviderConfigProvider,
  ProviderEndpointConfig,
} from "../db/repositories/provider-configs";
import { log } from "../log";
import type { ReasoningControl } from "./models-dev";

export type ModelInputModality = "text" | "image" | "audio" | "video" | "file";
export type ModelOutputModality = "text" | "image" | "audio" | "video" | "file";

export interface ProviderModelSearchResult {
  id: string;
  name?: string;
  description?: string;
  contextLength?: number;
  inputModalities: ModelInputModality[];
  outputModalities?: ModelOutputModality[];
  /**
   * Whether this MODEL can reason. Says nothing about whether its provider has
   * a way to express effort — that is `providerReasoningVocabulary`.
   *
   * `undefined` means UNKNOWN and must never be collapsed into `false`: `false`
   * asserts the model cannot think, which for an unrecognised id is a claim we
   * have no basis for. The UI shows the effort control only on `true`; the
   * server withholds reasoning options only on `false`.
   */
  reasoning?: boolean;
  /**
   * What this model accepts for controlling reasoning, from models.dev. Absent
   * means unknown; an EMPTY array would mean "reasons but exposes no control",
   * so the field is omitted rather than set to [] when we have no answer.
   */
  reasoningControls?: ReasoningControl[];
  source: "live" | "static";
}

export interface ProviderModelSearchResponse {
  provider: ProviderConfigProvider;
  query: string;
  source: "live" | "static" | "mixed";
  models: ProviderModelSearchResult[];
}

export interface LoadProviderModelsInput {
  provider: ProviderConfigProvider;
  fetchImpl: typeof fetch;
  secret: string | null;
  endpointConfig: ProviderEndpointConfig;
}

export interface SearchProviderModelsInput extends LoadProviderModelsInput {
  query: string;
  limit: number;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/**
 * `reasoning` here is the fallback for providers whose /models endpoint returns
 * ids only (OpenAI, Anthropic, DeepSeek) or has no live list at all (Z.AI, Qwen,
 * Workers AI). Values were taken from OpenRouter's `supported_parameters` for
 * the same underlying model families on 2026-08-01 — every family in this table
 * reports reasoning except llama-4. A live answer always wins over these (see
 * mergeStaticMetadata), and an admin can override per model.
 */
export const STATIC_MODELS: Record<ProviderConfigProvider, ProviderModelSearchResult[]> = {
  openai: [
    {
      id: "gpt-5.5",
      name: "GPT-5.5",
      contextLength: 400000,
      inputModalities: ["text", "image", "file"],
      reasoning: true,
      source: "static",
    },
    {
      id: "gpt-5.4-mini",
      name: "GPT-5.4 mini",
      contextLength: 400000,
      inputModalities: ["text", "image", "file"],
      reasoning: true,
      source: "static",
    },
    {
      id: "gpt-5.4",
      name: "GPT-5.4",
      contextLength: 1050000,
      inputModalities: ["text", "image", "file"],
      reasoning: true,
      source: "static",
    },
    {
      id: "gpt-5.3-codex-spark",
      name: "GPT-5.3 Codex Spark",
      inputModalities: ["text", "image", "file"],
      reasoning: true,
      source: "static",
    },
  ],
  "openai-oauth": [
    {
      id: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      contextLength: 272000,
      inputModalities: ["text", "image", "file"],
      reasoning: true,
      source: "static",
    },
    {
      id: "gpt-5.6-terra",
      name: "GPT-5.6 Terra",
      contextLength: 272000,
      inputModalities: ["text", "image", "file"],
      reasoning: true,
      source: "static",
    },
    {
      id: "gpt-5.6-luna",
      name: "GPT-5.6 Luna",
      contextLength: 272000,
      inputModalities: ["text", "image", "file"],
      reasoning: true,
      source: "static",
    },
    {
      id: "gpt-5.5",
      name: "GPT-5.5",
      contextLength: 400000,
      inputModalities: ["text", "image", "file"],
      reasoning: true,
      source: "static",
    },
    {
      id: "gpt-5.4-mini",
      name: "GPT-5.4 mini",
      contextLength: 400000,
      inputModalities: ["text", "image", "file"],
      reasoning: true,
      source: "static",
    },
    {
      id: "gpt-5.4",
      name: "GPT-5.4",
      contextLength: 1050000,
      inputModalities: ["text", "image", "file"],
      reasoning: true,
      source: "static",
    },
    {
      id: "gpt-5.3-codex-spark",
      name: "GPT-5.3 Codex Spark",
      inputModalities: ["text", "image", "file"],
      reasoning: true,
      source: "static",
    },
  ],
  anthropic: [
    {
      id: "claude-sonnet-5-20260630",
      name: "Claude Sonnet 5",
      contextLength: 1000000,
      inputModalities: ["text", "image", "file"],
      reasoning: true,
      source: "static",
    },
    {
      id: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6",
      contextLength: 1000000,
      inputModalities: ["text", "image", "file"],
      reasoning: true,
      source: "static",
    },
    {
      id: "claude-opus-4-8",
      name: "Claude Opus 4.8",
      contextLength: 1000000,
      inputModalities: ["text", "image", "file"],
      reasoning: true,
      source: "static",
    },
  ],
  openrouter: [
    {
      id: "openai/gpt-5.4-mini",
      name: "OpenAI GPT-5.4 mini",
      contextLength: 400000,
      inputModalities: ["text"],
      reasoning: true,
      source: "static",
    },
    {
      id: "anthropic/claude-sonnet-5",
      name: "Claude Sonnet 5",
      contextLength: 1000000,
      inputModalities: ["text", "image"],
      reasoning: true,
      source: "static",
    },
    {
      id: "deepseek/deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      contextLength: 1000000,
      inputModalities: ["text"],
      reasoning: true,
      source: "static",
    },
    {
      id: "z-ai/glm-5.2",
      name: "Z.AI GLM-5.2",
      contextLength: 1000000,
      inputModalities: ["text"],
      reasoning: true,
      source: "static",
    },
  ],
  deepseek: [
    {
      id: "deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      contextLength: 1000000,
      inputModalities: ["text"],
      reasoning: true,
      source: "static",
    },
    {
      id: "deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      contextLength: 1000000,
      inputModalities: ["text"],
      reasoning: true,
      source: "static",
    },
  ],
  zai: [
    {
      id: "glm-5.2",
      name: "GLM-5.2",
      contextLength: 1000000,
      inputModalities: ["text"],
      reasoning: true,
      source: "static",
    },
    {
      id: "glm-5.1",
      name: "GLM-5.1",
      inputModalities: ["text"],
      reasoning: true,
      source: "static",
    },
    {
      id: "glm-5-turbo",
      name: "GLM-5-Turbo",
      contextLength: 200000,
      inputModalities: ["text"],
      reasoning: true,
      source: "static",
    },
    {
      id: "glm-4.7",
      name: "GLM-4.7",
      inputModalities: ["text"],
      reasoning: true,
      source: "static",
    },
    {
      id: "glm-4.7-flash",
      name: "GLM-4.7 Flash",
      contextLength: 200000,
      inputModalities: ["text"],
      reasoning: true,
      source: "static",
    },
  ],
  qwen: [
    {
      id: "qwen3.7-max",
      name: "Qwen 3.7 Max",
      inputModalities: ["text"],
      reasoning: true,
      source: "static",
    },
    {
      id: "qwen3.7-plus",
      name: "Qwen 3.7 Plus",
      contextLength: 1000000,
      inputModalities: ["text", "image"],
      reasoning: true,
      source: "static",
    },
    {
      id: "qwen3.6-flash",
      name: "Qwen 3.6 Flash",
      contextLength: 1000000,
      inputModalities: ["text"],
      reasoning: true,
      source: "static",
    },
    {
      id: "qwen3.5-omni-plus",
      name: "Qwen 3.5 Omni Plus",
      inputModalities: ["text", "image", "audio", "video"],
      reasoning: true,
      source: "static",
    },
  ],
  "opencode-go": [
    {
      id: "glm-5.2",
      name: "GLM-5.2",
      contextLength: 1000000,
      inputModalities: ["text"],
      reasoning: true,
      source: "static",
    },
    {
      id: "glm-5.1",
      name: "GLM-5.1",
      contextLength: 202752,
      inputModalities: ["text"],
      reasoning: true,
      source: "static",
    },
    {
      id: "kimi-k2.7-code",
      name: "Kimi K2.7 Code",
      contextLength: 262144,
      inputModalities: ["text"],
      reasoning: true,
      source: "static",
    },
    {
      id: "kimi-k2.6",
      name: "Kimi K2.6",
      contextLength: 262144,
      inputModalities: ["text"],
      reasoning: true,
      source: "static",
    },
    {
      id: "mimo-v2.5",
      name: "MiMo V2.5",
      contextLength: 1000000,
      inputModalities: ["text"],
      reasoning: true,
      source: "static",
    },
    {
      id: "mimo-v2.5-pro",
      name: "MiMo V2.5 Pro",
      contextLength: 1048576,
      inputModalities: ["text"],
      reasoning: true,
      source: "static",
    },
    {
      id: "minimax-m3",
      name: "MiniMax-M3",
      contextLength: 1000000,
      inputModalities: ["text"],
      reasoning: true,
      source: "static",
    },
    {
      id: "minimax-m2.7",
      name: "MiniMax-M2.7",
      contextLength: 204800,
      inputModalities: ["text"],
      reasoning: true,
      source: "static",
    },
    {
      id: "qwen3.7-max",
      name: "Qwen3.7 Max",
      contextLength: 1000000,
      inputModalities: ["text"],
      reasoning: true,
      source: "static",
    },
    {
      id: "qwen3.7-plus",
      name: "Qwen3.7 Plus",
      contextLength: 1000000,
      inputModalities: ["text"],
      reasoning: true,
      source: "static",
    },
    {
      id: "qwen3.6-plus",
      name: "Qwen3.6 Plus",
      contextLength: 1000000,
      inputModalities: ["text"],
      reasoning: true,
      source: "static",
    },
    {
      id: "deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      contextLength: 1000000,
      inputModalities: ["text"],
      reasoning: true,
      source: "static",
    },
    {
      id: "deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      contextLength: 1000000,
      inputModalities: ["text"],
      reasoning: true,
      source: "static",
    },
  ],
  // Zen's `*-free` models are deliberately NOT curated here. They are throttled
  // per egress IP, and a Cloudflare Worker's IP is shared across all of
  // Cloudflare — so they answer 429 FreeUsageLimitError from Nadi regardless of
  // the key (verified: keyless from the Worker is throttled identically, while
  // keyless from a normal IP succeeds). Listing them would sell a model that
  // cannot answer.
  //
  // A readable overlay for the headline paid models instead. The full catalog
  // comes from the live /models fetch; this is only the fallback when that fails.
  // Context windows are the same ids we already curate for the underlying
  // providers, not guesses.
  "opencode-zen": [
    {
      id: "claude-sonnet-5",
      name: "Claude Sonnet 5",
      contextLength: 1000000,
      inputModalities: ["text"],
      reasoning: true,
      source: "static",
    },
    {
      id: "claude-opus-4-8",
      name: "Claude Opus 4.8",
      contextLength: 1000000,
      inputModalities: ["text"],
      reasoning: true,
      source: "static",
    },
    {
      id: "gpt-5.5",
      name: "GPT-5.5",
      contextLength: 400000,
      inputModalities: ["text"],
      reasoning: true,
      source: "static",
    },
    {
      id: "deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      contextLength: 1000000,
      inputModalities: ["text"],
      reasoning: true,
      source: "static",
    },
    {
      id: "glm-5.2",
      name: "GLM-5.2",
      contextLength: 1000000,
      inputModalities: ["text"],
      reasoning: true,
      source: "static",
    },
    {
      id: "kimi-k2.7-code",
      name: "Kimi K2.7 Code",
      contextLength: 262144,
      inputModalities: ["text"],
      reasoning: true,
      source: "static",
    },
  ],
  "openai-compatible": [],
  // Curated to models whose tool calling was verified live against the AI
  // binding — Nadi's agent is tool-heavy, so a model that won't call a tool is
  // useless here, and the docs are not a reliable guide. Excluded on evidence:
  //   - glm-4.7-flash: advertised as multi-turn tool calling, but never emits a
  //     tool call through this path — it just finishes with empty text.
  //   - llama-3.3-70b-instruct-fp8-fast: calls tools, but its 24k context window
  //     is too small for the system prompt plus tool definitions.
  // glm-5.2 works but is capacity-constrained upstream (intermittent 429 3040),
  // so it is listed below the models that answer reliably.
  "workers-ai": [
    {
      id: "@cf/moonshotai/kimi-k2.7-code",
      name: "Kimi K2.7 Code",
      description: "Frontier agentic/coding model. Tools, reasoning, vision.",
      contextLength: 262144,
      inputModalities: ["text", "image"],
      reasoning: true,
      source: "static",
    },
    {
      id: "@cf/moonshotai/kimi-k2.6",
      name: "Kimi K2.6",
      description: "1T-parameter agentic model. Tools, reasoning, vision.",
      contextLength: 262144,
      inputModalities: ["text", "image"],
      reasoning: true,
      source: "static",
    },
    {
      id: "@cf/openai/gpt-oss-120b",
      name: "GPT-OSS 120B",
      description: "OpenAI open-weight model. Tools, reasoning.",
      contextLength: 128000,
      inputModalities: ["text"],
      reasoning: true,
      source: "static",
    },
    {
      id: "@cf/meta/llama-4-scout-17b-16e-instruct",
      name: "Llama 4 Scout 17B",
      description: "Natively multimodal MoE model. Tools, vision.",
      contextLength: 131000,
      inputModalities: ["text", "image"],
      // The one non-reasoning family in this catalog: OpenRouter reports
      // meta-llama/llama-4-scout and llama-4-maverick without `reasoning`.
      reasoning: false,
      source: "static",
    },
    {
      id: "@cf/google/gemma-4-26b-a4b-it",
      name: "Gemma 4 26B",
      description: "Efficient MoE model. Tools, vision, thinking mode.",
      contextLength: 256000,
      inputModalities: ["text", "image"],
      reasoning: true,
      source: "static",
    },
    {
      id: "@cf/zai-org/glm-5.2",
      name: "GLM-5.2",
      description: "Agentic coding model. Tools, reasoning. Can be capacity-limited.",
      contextLength: 262144,
      inputModalities: ["text"],
      reasoning: true,
      source: "static",
    },
  ],
};

export function normalizeModelSearchLimit(value: string | null): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

export function getStaticProviderModels(
  provider: ProviderConfigProvider,
): ProviderModelSearchResult[] {
  return STATIC_MODELS[provider] ?? [];
}

/**
 * The provider's full model list — every model, unfiltered and unclamped.
 *
 * `MAX_LIMIT` deliberately does not apply here. It bounds a *search response*;
 * applying it to the catalog would silently truncate OpenRouter's ~300 models
 * to 50 and present the result as the complete list.
 */
export async function loadProviderModels(
  input: LoadProviderModelsInput,
): Promise<{ models: ProviderModelSearchResult[]; source: "live" | "static" }> {
  const staticModels = filterTextOutputModels(getStaticProviderModels(input.provider));
  const liveModels = await fetchLiveModels(input).catch((error: unknown) => {
    // This swallow is what hid the illegal-invocation bug: a total failure
    // rendered as a plausible static list for months. It stays silent to the
    // user by design; it must not stay silent in the logs.
    log.error("provider.model_list_threw", {
      provider: input.provider,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  });

  if (!liveModels) return { models: staticModels, source: "static" };

  return {
    models: mergeStaticMetadata(
      filterTextOutputModels(liveModels),
      getStaticProviderModels(input.provider),
    ),
    source: "live",
  };
}

export async function searchProviderModels(
  input: SearchProviderModelsInput,
): Promise<ProviderModelSearchResponse> {
  const query = input.query.trim();
  const limit = Math.min(Math.max(input.limit, 1), MAX_LIMIT);
  const { models, source } = await loadProviderModels(input);
  return {
    provider: input.provider,
    query,
    source,
    models: filterModels(models, query).slice(0, limit),
  };
}

/** Shared by the search route and the client's local filtering, so "does this
 *  model match what I typed" means the same thing on both sides. */
export function filterProviderModels(
  models: ProviderModelSearchResult[],
  query: string,
): ProviderModelSearchResult[] {
  return filterModels(models, query.trim());
}

function filterModels(
  models: ProviderModelSearchResult[],
  query: string,
): ProviderModelSearchResult[] {
  if (!query) return models;
  const normalized = query.toLowerCase();
  return models.filter((model) => {
    return (
      model.id.toLowerCase().includes(normalized) ||
      model.name?.toLowerCase().includes(normalized) ||
      model.description?.toLowerCase().includes(normalized)
    );
  });
}

function filterTextOutputModels(models: ProviderModelSearchResult[]): ProviderModelSearchResult[] {
  return models.filter((model) => {
    return model.outputModalities === undefined || model.outputModalities.includes("text");
  });
}

async function fetchLiveModels(
  input: LoadProviderModelsInput,
): Promise<ProviderModelSearchResult[] | null> {
  if (
    input.provider === "zai" ||
    input.provider === "qwen" ||
    input.provider === "openai-oauth" ||
    // Workers AI has no per-workspace endpoint or key to list against, and its
    // catalog is deliberately curated to tool-capable models — a live list would
    // re-introduce the ones that cannot call tools.
    input.provider === "workers-ai"
  ) {
    return null;
  }
  if (input.endpointConfig.auth === "bearer" && !input.secret) return null;

  const url = modelListUrl(input.provider, input.endpointConfig.baseUrl);
  if (!url) return null;

  const headers: Record<string, string> = { Accept: "application/json" };
  if (input.endpointConfig.auth === "bearer" && input.secret) {
    headers.Authorization = `Bearer ${input.secret}`;
  }
  if (input.provider === "anthropic") {
    delete headers.Authorization;
    headers["x-api-key"] = input.secret ?? "";
    headers["anthropic-version"] = "2023-06-01";
  }

  // Detach the impl before calling it. `input.fetchImpl(...)` is a method call,
  // which binds `this` to `input` — and the Workers runtime throws "Illegal
  // invocation" when native fetch gets the wrong `this`. searchProviderModels
  // swallows that throw, silently degrading every provider to its static list.
  const doFetch = input.fetchImpl;
  const response = await doFetch(url, { headers });
  if (!response.ok) {
    // The caller degrades to the static list, which looks like a plausible answer
    // — so an unhealthy provider is invisible unless we say so here.
    log.error("provider.model_list_failed", {
      provider: input.provider,
      url,
      status: response.status,
    });
    return null;
  }
  return normalizeLiveModels(input.provider, await response.json());
}

export function modelListUrl(provider: ProviderConfigProvider, baseUrl: string): string | null {
  if (provider === "openai") return "https://api.openai.com/v1/models";
  if (provider === "anthropic") return "https://api.anthropic.com/v1/models";
  if (provider === "openrouter") return "https://openrouter.ai/api/v1/models";
  if (provider === "deepseek") return "https://api.deepseek.com/models";
  if (provider === "opencode-go") return "https://opencode.ai/zen/go/v1/models";
  if (provider === "opencode-zen") return "https://opencode.ai/zen/v1/models";
  if (provider === "openai-compatible" && baseUrl.trim()) {
    return `${baseUrl.replace(/\/+$/, "")}/models`;
  }
  return null;
}

function normalizeLiveModels(
  provider: ProviderConfigProvider,
  payload: unknown,
): ProviderModelSearchResult[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return [];
  return payload.data
    .map((entry) => normalizeLiveModel(provider, entry))
    .filter((entry): entry is ProviderModelSearchResult => entry !== null);
}

function normalizeLiveModel(
  provider: ProviderConfigProvider,
  entry: unknown,
): ProviderModelSearchResult | null {
  if (!isRecord(entry) || typeof entry.id !== "string") return null;
  const architecture = isRecord(entry.architecture) ? entry.architecture : null;
  const inputModalities = normalizeModalities(architecture?.input_modalities);
  const outputModalities = normalizeModalities(architecture?.output_modalities);
  const reasoning = normalizeReasoningSupport(entry.supported_parameters);
  return {
    id: entry.id,
    ...(typeof entry.name === "string" ? { name: entry.name } : {}),
    ...(typeof entry.description === "string" ? { description: entry.description } : {}),
    ...(typeof entry.context_length === "number" ? { contextLength: entry.context_length } : {}),
    inputModalities:
      inputModalities.length > 0 ? inputModalities : staticModalitiesFor(provider, entry.id),
    ...(outputModalities.length > 0 ? { outputModalities } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    source: "live",
  };
}

function mergeStaticMetadata(
  liveModels: ProviderModelSearchResult[],
  staticModels: ProviderModelSearchResult[],
): ProviderModelSearchResult[] {
  const staticById = new Map(staticModels.map((model) => [model.id, model]));
  return liveModels.map((model) => {
    const staticModel = staticById.get(model.id);
    const name = model.name ?? staticModel?.name;
    const description = model.description ?? staticModel?.description;
    const contextLength = model.contextLength ?? staticModel?.contextLength;
    const outputModalities = model.outputModalities ?? staticModel?.outputModalities;
    // `??` not `||`: a live `reasoning: false` is a real answer and must not be
    // overwritten by the static table's guess.
    const reasoning = model.reasoning ?? staticModel?.reasoning;
    return {
      ...model,
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(contextLength !== undefined ? { contextLength } : {}),
      ...(outputModalities !== undefined ? { outputModalities } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
      inputModalities:
        model.inputModalities.length > 0
          ? model.inputModalities
          : (staticModel?.inputModalities ?? ["text"]),
    };
  });
}

function staticModalitiesFor(provider: ProviderConfigProvider, id: string): ModelInputModality[] {
  return STATIC_MODELS[provider]?.find((model) => model.id === id)?.inputModalities ?? ["text"];
}

/**
 * OpenRouter publishes a `supported_parameters` array per model; `reasoning` in
 * it is authoritative (verified 2026-08-01: 336/336 models carry the field, 211
 * declare reasoning and 125 do not). Parsed for ANY provider that supplies the
 * field rather than special-casing OpenRouter, so a gateway that starts
 * publishing it is picked up for free. Absent field stays `undefined` = unknown.
 */
function normalizeReasoningSupport(value: unknown): boolean | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.includes("reasoning") || value.includes("reasoning_effort");
}

function normalizeModalities(value: unknown): ModelInputModality[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set<ModelInputModality>(["text", "image", "audio", "video", "file"]);
  return value.filter((entry): entry is ModelInputModality => {
    return typeof entry === "string" && allowed.has(entry as ModelInputModality);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
