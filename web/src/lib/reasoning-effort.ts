/**
 * Web-side mirror of the server's provider vocabulary list.
 *
 * Kept as its own module (rather than inlined in a component) so the parity test
 * in `test/unit/web/` can import it alongside the server's copy — that project
 * typechecks both trees, so the two lists drifting apart is a test failure
 * rather than a silent UI lie.
 */
import type { ReasoningControl, ReasoningEffort, SettingsProvider } from "../settings-api";

/**
 * Providers whose wire format the server can write reasoning options for.
 * Mirrors `PROVIDERS_WE_CAN_ADDRESS` in `src/agent/reasoning-options.ts`.
 *
 * This is not "which providers support reasoning" — that is per model, from
 * models.dev. The opencode gateways are here because models.dev confirms their
 * models reason and declares each one's vocabulary.
 */
const PROVIDERS_WITH_EFFORT_VOCABULARY = new Set<string>([
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
  return PROVIDERS_WITH_EFFORT_VOCABULARY.has(provider);
}

/**
 * Whether the composer should offer the effort control.
 *
 * Hides only on a KNOWN `false`, matching the server. An earlier version
 * required a known `true`, on the reasoning that we should not offer a control
 * for a model we cannot vouch for. That was wrong, and incoherently so: the
 * server already sends reasoning options for unknown models, so the model was
 * thinking — visibly — while the user had no way to turn it down. Most catalogs
 * publish no capability at all, so "unknown" is the common case, not the edge.
 *
 * The provider half is unchanged: a reasoning model on a provider with no way to
 * express effort is still uncontrollable, and a control there would be a lie.
 */
export function shouldOfferEffortControl(input: {
  provider: SettingsProvider | null;
  modelSupportsReasoning: boolean | null;
}): boolean {
  if (input.provider === null) return false;
  if (input.modelSupportsReasoning === false) return false;
  return providerSupportsReasoningEffort(input.provider);
}

/**
 * Per-model effort vocabulary for a thread's current model, when the workspace
 * whitelist (or a catalog-backed curated list) already carries it. Absent means
 * unknown — callers keep the full default option set.
 */
export function reasoningControlsForThreadModel(
  providers: Array<{
    provider: string;
    whitelistModels?: Array<{ id: string; reasoningControls?: ReasoningControl[] }> | null;
  }>,
  provider: string,
  model: string,
): ReasoningControl[] | undefined {
  const entry = providers.find((item) => item.provider === provider);
  return entry?.whitelistModels?.find((item) => item.id === model)?.reasoningControls;
}

/** What the EffortDial needs to know: which model the NEXT message will
 *  actually run on, and whether that model can reason. */
export interface DialModel {
  provider: string;
  model: string;
  /** `null` = unknown — the same tri-state as `ThreadSummary.modelSupportsReasoning`. */
  modelSupportsReasoning: boolean | null;
}

/**
 * The model the EffortDial should read controls for: the pending switch when
 * one exists, otherwise the thread's committed model.
 *
 * A pending switch's `modelSupportsReasoning` is its OWN claim about the
 * model it points at — when absent that means "unknown for the new model",
 * not "fall back to what the thread's old model claimed". Reusing the
 * thread's value here would silently show/hide the dial based on a model
 * that isn't the one about to run.
 */
export function dialModelFor(
  thread: { provider: string; model: string; modelSupportsReasoning: boolean | null },
  pendingModel: { provider: string; model: string; modelSupportsReasoning?: boolean } | null,
): DialModel {
  if (pendingModel === null) {
    return {
      provider: thread.provider,
      model: thread.model,
      modelSupportsReasoning: thread.modelSupportsReasoning,
    };
  }
  return {
    provider: pendingModel.provider,
    model: pendingModel.model,
    modelSupportsReasoning: pendingModel.modelSupportsReasoning ?? null,
  };
}

export interface EffortOption {
  level: ReasoningEffort;
  /** The model's own word for this setting where it has one. */
  label: string;
}

const DEFAULT_OPTIONS: EffortOption[] = [
  { level: "off", label: "Off" },
  { level: "low", label: "Low" },
  { level: "medium", label: "Medium" },
  { level: "high", label: "High" },
];

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * The levels a model can actually be set to.
 *
 * Four fixed levels are a fiction on most models: a toggle-only model has two
 * states, and one declaring `high|max` has two intensities, not three. Offering
 * Low/Medium/High there implies granularity the model does not have — the wire
 * is correct either way, but the UI was overstating it.
 *
 * `undefined` controls means UNKNOWN, which keeps the full set: we cannot say
 * a model lacks granularity just because we have no entry for it.
 * An EMPTY array is different — the model reasons but exposes nothing to tune,
 * so there is no control to render at all.
 */
export function availableEffortOptions(controls: ReasoningControl[] | undefined): EffortOption[] {
  if (controls === undefined) return DEFAULT_OPTIONS;
  if (controls.length === 0) return [];

  const effort = controls.find((control) => control.type === "effort");
  const hasToggle = controls.some((control) => control.type === "toggle");
  const hasBudget = controls.some((control) => control.type === "budget_tokens");

  if (effort) {
    // "none" is the model's off switch, not an intensity.
    const values = effort.values.filter((value) => value !== "none");
    const off: EffortOption = { level: "off", label: "Off" };
    if (values.length === 0) return hasToggle ? [off, { level: "medium", label: "On" }] : [];
    if (values.length === 1) return [off, { level: "high", label: titleCase(values[0] as string) }];
    if (values.length === 2) {
      return [
        off,
        { level: "low", label: titleCase(values[0] as string) },
        { level: "high", label: titleCase(values[1] as string) },
      ];
    }
    // Three or more: our own scale spans it, so keep our labels.
    return DEFAULT_OPTIONS;
  }

  // A budget is continuous, so our three levels are a reasonable slicing.
  if (hasBudget) return DEFAULT_OPTIONS;

  // Toggle only: two states, and calling one of them "High" would be a lie.
  return [
    { level: "off", label: "Off" },
    { level: "medium", label: "On" },
  ];
}
