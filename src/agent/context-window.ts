import type { ProviderConfigProvider } from "../db/repositories/provider-configs";
import { getStaticProviderModels } from "../providers/model-search";
import { DEFAULT_CONTEXT_WINDOW } from "./context-budget";

/**
 * Resolve the context window for a thread's model.
 *
 * Looked up at turn time rather than persisted: the model can be overridden
 * per-thread AND per-automaton, so persistence would mean carrying the value
 * through three tables and their write paths. Keying off the RESOLVED
 * provider+model covers all three override layers for free.
 *
 * Known gap: an OpenRouter model outside the curated list gets the conservative
 * default rather than its true (often larger) window. That under-uses context
 * but never overflows — the safe direction.
 */
export function resolveContextWindow(input: {
  provider: string;
  model: string;
  env: { THINK_COMPACT_AFTER_TOKENS?: string };
}): number {
  const catalog = catalogWindow(input.provider, input.model);
  if (catalog !== null) return catalog;

  const override = Number(input.env.THINK_COMPACT_AFTER_TOKENS?.trim() ?? "");
  if (Number.isFinite(override) && override > 0) return Math.floor(override);

  return DEFAULT_CONTEXT_WINDOW;
}

function catalogWindow(provider: string, model: string): number | null {
  const models = getStaticProviderModels(provider as ProviderConfigProvider);
  const entry = models.find((candidate) => candidate.id === model);
  const contextLength = entry?.contextLength;
  return typeof contextLength === "number" && contextLength > 0 ? contextLength : null;
}
