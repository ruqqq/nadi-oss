/**
 * Per-provider `providerOptions` fragment expressing a thinking-effort level.
 *
 * Two separate questions, deliberately not merged (see the design spec):
 *
 * - **Can this MODEL think?** — `modelSupportsReasoning`, resolved from the
 *   catalog. Not decided here.
 * - **How does this PROVIDER spell effort?** — this file. Every provider has its
 *   own vocabulary: an effort string, a token budget, or a boolean plus a budget.
 *
 * Reasoning also has to be *persistable*: without a text summary, OpenAI
 * reasoning parts are encrypted-only, `@cloudflare/ai-chat`'s sanitize step drops
 * the empty part, and "thinking" vanishes on refresh. `openai-oauth` always keeps
 * `store: false`, independent of reasoning.
 */
import type { JSONValue } from "ai";
import type { ModelReasoningProfile } from "../providers/models-dev";

export const REASONING_EFFORTS = ["off", "low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "medium";

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);
}

export function parseReasoningEffort(value: unknown): ReasoningEffort | null {
  return isReasoningEffort(value) ? value : null;
}

/**
 * Providers whose wire format we know how to write reasoning options for.
 *
 * This is NOT "which providers support effort" — that is a per-model question
 * answered by models.dev (see `ModelReasoningProfile`). This is only "can we
 * serialize a control for this provider's API at all". `openai-compatible` is
 * absent because it points at an arbitrary endpoint.
 */
const PROVIDERS_WE_CAN_ADDRESS = new Set([
  "openai",
  "openai-oauth",
  "anthropic",
  "openrouter",
  "deepseek",
  "zai",
  "qwen",
  "opencode-go",
  "opencode-zen",
]);

export function providerSupportsReasoningEffort(provider: string): boolean {
  return PROVIDERS_WE_CAN_ADDRESS.has(provider);
}

/** Our four levels, ordered, for mapping onto a model's own scale. */
const LEVEL_ORDER: Exclude<ReasoningEffort, "off">[] = ["low", "medium", "high"];

/**
 * Maps one of our levels onto the values a model actually accepts.
 *
 * Models declare wildly different scales — `high|max`, `low|medium|high`,
 * `none|low|medium|high|xhigh|max`, sometimes just `max`. Rather than send a
 * value that will be rejected or silently ignored, position our level within
 * the model's own list proportionally, so `low` is always its weakest usable
 * setting and `high` always its strongest.
 */
export function mapEffortToModelScale(
  effort: Exclude<ReasoningEffort, "off">,
  values: string[],
): string | null {
  // "none" is an off switch, not an intensity — never a target for low/medium/high.
  const usable = values.filter((value) => value !== "none");
  if (usable.length === 0) return null;
  if (usable.length === 1) return usable[0] ?? null;
  const index = LEVEL_ORDER.indexOf(effort);
  const position = Math.round((index / (LEVEL_ORDER.length - 1)) * (usable.length - 1));
  return usable[position] ?? null;
}

/** Our levels as a fraction of a model's declared budget window. */
function budgetFor(
  effort: Exclude<ReasoningEffort, "off">,
  control: { min?: number; max?: number },
): number {
  const min = control.min ?? 1024;
  const max = control.max ?? 32768;
  const fraction = { low: 0, medium: 0.25, high: 1 }[effort];
  return Math.max(min, Math.round(min + (max - min) * fraction));
}

export function buildReasoningProviderOptions(
  provider: string,
  opts: {
    effort: ReasoningEffort;
    /**
     * What this MODEL accepts, from models.dev. `null` means we have no entry —
     * treated as permission to send our provider-shaped default, because a
     * missing catalog must not silently stop threads thinking.
     */
    profile?: ModelReasoningProfile | null;
    /**
     * Legacy per-thread capability snapshot, used only when `profile` is absent.
     * `undefined` is UNKNOWN and permits sending; only an explicit `false` blocks.
     */
    modelSupportsReasoning?: boolean | undefined;
  },
): Record<string, Record<string, JSONValue>> {
  if (!PROVIDERS_WE_CAN_ADDRESS.has(provider)) return {};

  const profile = opts.profile ?? null;
  // models.dev is authoritative when we have it; otherwise fall back to the
  // thread's recorded capability, where unknown still means "go ahead".
  const canReason = profile ? profile.reasoning : opts.modelSupportsReasoning !== false;
  const on = opts.effort !== "off" && canReason;

  if (provider === "openai-oauth") {
    const base: Record<string, JSONValue> = { store: false };
    if (!on) return { openai: base };
    const effort = resolveEffortValue(opts.effort, profile, ["low", "medium", "high"]);
    return {
      openai: { ...base, ...(effort ? { reasoningEffort: effort } : {}), reasoningSummary: "auto" },
    };
  }

  // A model that cannot reason has nothing to disable — saying "thinking off"
  // to it is at best noise and at worst a rejected field. Only a model that
  // CAN reason gets a positive off statement.
  if (!canReason) return {};
  if (!on) return offOptionsFor(provider, profile);

  const level = opts.effort as Exclude<ReasoningEffort, "off">;
  const controls = profile?.controls ?? null;

  // A model that reasons but exposes NO control: send nothing. Guessing here is
  // what sent budgets to models that only accept an effort string.
  if (controls !== null && controls.length === 0) return {};

  const effortControl = controls?.find((c) => c.type === "effort");
  const budgetControl = controls?.find((c) => c.type === "budget_tokens");
  const hasToggle = controls?.some((c) => c.type === "toggle") ?? false;

  switch (provider) {
    case "openai": {
      const value = resolveEffortValue(opts.effort, profile, ["low", "medium", "high"]);
      return { openai: { ...(value ? { reasoningEffort: value } : {}), reasoningSummary: "auto" } };
    }
    case "anthropic": {
      // Newer Anthropic models take an effort string and NOT a token budget;
      // older ones take only a budget. Follow what the model declares.
      if (effortControl) {
        const value = mapEffortToModelScale(level, effortControl.values);
        if (value) return { anthropic: { thinking: { type: "enabled", effort: value } } };
      }
      const budget = budgetControl
        ? budgetFor(level, budgetControl)
        : { low: 1024, medium: 2048, high: 8192 }[level];
      return { anthropic: { thinking: { type: "enabled", budgetTokens: budget } } };
    }
    case "openrouter": {
      if (effortControl) {
        const value = mapEffortToModelScale(level, effortControl.values);
        if (value) return { openrouter: { reasoning: { effort: value } } };
      }
      if (budgetControl) {
        return { openrouter: { reasoning: { max_tokens: budgetFor(level, budgetControl) } } };
      }
      return { openrouter: { reasoning: { effort: level } } };
    }
    default: {
      // The OpenAI-compatible family (deepseek, zai, qwen, the opencode
      // gateways). Keys are spread verbatim into the request body by the
      // adapter, so each control maps to its own field.
      const body: Record<string, JSONValue> = {};
      if (hasToggle) {
        if (provider === "qwen") body.enable_thinking = true;
        else body.thinking = { type: "enabled" };
      }
      if (effortControl) {
        const value = mapEffortToModelScale(level, effortControl.values);
        if (value) body.reasoningEffort = value;
      }
      if (budgetControl) body.thinking_budget = budgetFor(level, budgetControl);
      if (Object.keys(body).length === 0) {
        // No profile at all: fall back to the provider's usual shape.
        if (provider === "qwen") {
          body.enable_thinking = true;
          body.thinking_budget = { low: 4096, medium: 16000, high: 32768 }[level];
        } else {
          body.reasoningEffort = level;
        }
      }
      return { [provider]: body };
    }
  }
}

/** Positions our level on the model's declared scale, or falls back. */
function resolveEffortValue(
  effort: ReasoningEffort,
  profile: ModelReasoningProfile | null,
  fallback: string[],
): string | null {
  if (effort === "off") return null;
  const control = profile?.controls.find((c) => c.type === "effort");
  return mapEffortToModelScale(effort, control ? control.values : fallback);
}

/**
 * Turning thinking OFF needs a positive statement wherever the provider defaults
 * it on — omitting the field would leave it enabled.
 */
function offOptionsFor(
  provider: string,
  profile: ModelReasoningProfile | null,
): Record<string, Record<string, JSONValue>> {
  const controls = profile?.controls ?? null;
  const effortControl = controls?.find((c) => c.type === "effort");

  // "none" as a declared effort value is the model's own off switch, and the
  // most precise thing we can send.
  if (effortControl?.values.includes("none")) {
    if (provider === "openai" || provider === "openai-oauth") {
      return { openai: { reasoningEffort: "none" } };
    }
    if (provider === "openrouter") return { openrouter: { reasoning: { effort: "none" } } };
    return { [provider]: { reasoningEffort: "none" } };
  }

  // Otherwise fall back to the provider's documented disable statement.
  //
  // Deliberately NOT conditioned on models.dev declaring a `toggle`. Its
  // reasoning_options list intensity controls and is inconsistent about
  // toggles for the same underlying model — deepseek-v4-pro lists
  // `toggle + effort` under the deepseek provider but only `effort` under
  // opencode-go — while DeepSeek's API documents `thinking: {type:"disabled"}`
  // either way. Treating that absence as "no off switch exists" made Off a
  // no-op: we sent nothing and the provider's default (thinking ON) applied.
  //
  // Omitting the field is never a way to turn thinking OFF on these providers,
  // because they all default it on. The worst case for sending it to a model
  // that truly has no switch is that the field is ignored.
  switch (provider) {
    case "qwen":
      return { qwen: { enable_thinking: false } };
    case "anthropic":
      return { anthropic: { thinking: { type: "disabled" } } };
    case "deepseek":
    case "zai":
    case "opencode-go":
    case "opencode-zen":
      return { [provider]: { thinking: { type: "disabled" } } };
    default:
      // openai and openrouter reason by default on reasoning models and expose
      // no disable other than an effort value of "none", handled above. Omitting
      // is all we can honestly do; the composer should stop offering Off for
      // these models (follow-up).
      return {};
  }
}
