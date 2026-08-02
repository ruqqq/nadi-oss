/**
 * models.dev as the source of truth for per-model reasoning capability.
 *
 * This is where the OpenCode CLI gets its model metadata, and it publishes two
 * things no provider `/models` endpoint does: whether a model reasons, and the
 * *vocabulary* it accepts for controlling that reasoning.
 *
 * The vocabulary is per MODEL, not per provider — the thing an earlier version
 * of this feature got wrong. Verified against the live catalog on 2026-08-01:
 *
 *   claude-opus-4-8   effort(low|medium|high|xhigh|max)   — and NO budget_tokens
 *   claude-haiku-4-5  budget_tokens                        — and no effort
 *   glm-5.1, glm-4.7  toggle only
 *   glm-5.2           effort(high|max)
 *   deepseek-chat     no controls at all
 *
 * A provider-level table cannot express any of that, so it sent budgets to
 * models that take an effort string and effort strings to models that take only
 * a toggle.
 */
import { log } from "../log";

export const MODELS_DEV_URL = "https://models.dev/api.json";

/**
 * Our provider ids → models.dev provider ids.
 *
 * `openai-oauth` maps to `openai`: it serves the same model ids (gpt-5.6-sol
 * and friends) through a different auth path. `openai-compatible` is absent by
 * definition — it points at an arbitrary endpoint.
 */
export const MODELS_DEV_PROVIDER_IDS: Record<string, string> = {
  openai: "openai",
  "openai-oauth": "openai",
  anthropic: "anthropic",
  openrouter: "openrouter",
  deepseek: "deepseek",
  zai: "zhipuai",
  qwen: "alibaba",
  "opencode-go": "opencode-go",
  "opencode-zen": "opencode",
  "workers-ai": "cloudflare-workers-ai",
};

export type ReasoningControl =
  | { type: "effort"; values: string[] }
  | { type: "budget_tokens"; min?: number; max?: number }
  | { type: "toggle" };

export interface ModelReasoningProfile {
  /** Whether the model reasons at all. */
  reasoning: boolean;
  /**
   * How its reasoning can be controlled. EMPTY is meaningful and different from
   * absent: the model reasons but exposes no knob (many Kimi and MiMo models),
   * so we must send nothing rather than guess.
   */
  controls: ReasoningControl[];
}

/** provider (ours) → model id → profile. */
export type ModelsDevCatalog = Record<string, Record<string, ModelReasoningProfile>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseControls(value: unknown): ReasoningControl[] {
  if (!Array.isArray(value)) return [];
  const controls: ReasoningControl[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.type !== "string") continue;
    if (entry.type === "effort") {
      const values = Array.isArray(entry.values)
        ? entry.values.filter((v): v is string => typeof v === "string")
        : [];
      // An effort control with no values tells us nothing actionable.
      if (values.length > 0) controls.push({ type: "effort", values });
    } else if (entry.type === "budget_tokens") {
      controls.push({
        type: "budget_tokens",
        ...(typeof entry.min === "number" ? { min: entry.min } : {}),
        ...(typeof entry.max === "number" ? { max: entry.max } : {}),
      });
    } else if (entry.type === "toggle") {
      controls.push({ type: "toggle" });
    }
  }
  return controls;
}

/**
 * Prunes the ~3.3 MB upstream payload to the ~39 KB we actually use: our nine
 * providers, and only the reasoning fields.
 */
export function parseModelsDevPayload(payload: unknown): ModelsDevCatalog {
  if (!isRecord(payload)) return {};
  const catalog: ModelsDevCatalog = {};
  for (const [ours, theirs] of Object.entries(MODELS_DEV_PROVIDER_IDS)) {
    const provider = payload[theirs];
    if (!isRecord(provider) || !isRecord(provider.models)) continue;
    const models: Record<string, ModelReasoningProfile> = {};
    for (const [id, model] of Object.entries(provider.models)) {
      if (!isRecord(model)) continue;
      models[id] = {
        reasoning: model.reasoning === true,
        controls: parseControls(model.reasoning_options),
      };
    }
    if (Object.keys(models).length > 0) catalog[ours] = models;
  }
  return catalog;
}

export async function fetchModelsDevCatalog(
  fetchImpl: typeof fetch,
): Promise<ModelsDevCatalog | null> {
  try {
    // Detached before calling: a method call binds `this` to the wrong object
    // and the Workers runtime throws "Illegal invocation".
    const doFetch = fetchImpl;
    const response = await doFetch(MODELS_DEV_URL, { headers: { Accept: "application/json" } });
    if (!response.ok) {
      log.error("models_dev.fetch_failed", { status: response.status });
      return null;
    }
    return parseModelsDevPayload(await response.json());
  } catch (error) {
    log.error("models_dev.fetch_threw", { error: String(error) });
    return null;
  }
}

/**
 * Looks up a model, tolerating the id prefixes gateways add. OpenRouter serves
 * `anthropic/claude-sonnet-5` while Anthropic serves `claude-sonnet-5`, and a
 * dated suffix (`claude-sonnet-5-20260630`) is the same model as its base id.
 */
export function findModelProfile(
  catalog: ModelsDevCatalog,
  provider: string,
  modelId: string,
): ModelReasoningProfile | null {
  const models = catalog[provider];
  if (!models) return null;
  const exact = models[modelId];
  if (exact) return exact;

  const bare = modelId.includes("/") ? (modelId.split("/").pop() ?? modelId) : modelId;
  if (models[bare]) return models[bare];

  // Longest matching prefix, so `claude-sonnet-5-20260630` resolves to
  // `claude-sonnet-5` rather than to a shorter, different family member.
  let best: { id: string; profile: ModelReasoningProfile } | null = null;
  for (const [id, profile] of Object.entries(models)) {
    if (!bare.startsWith(id)) continue;
    if (!best || id.length > best.id.length) best = { id, profile };
  }
  return best?.profile ?? null;
}
