import { hasOfferableModels } from "./model-picker";
import { defaultModelForProvider } from "../settings-ui-config";
import {
  isReasoningEffort,
  isSettingsProvider,
  type AgentSettingsResponse,
  type ModelInputModality,
  type ProviderSettingsView,
  type ReasoningControl,
  type ReasoningEffort,
  type SettingsProvider,
} from "../settings-api";

export interface NewChatModelState {
  /** Usable providers that still have something to offer. */
  providers: ProviderSettingsView[];
  /**
   * Whether any provider is usable at all, before the curated-to-zero ones are
   * dropped. `providers` being empty means "you can't start a chat"; this says
   * which of the two reasons it is — no credentials, or no models turned on —
   * and they point at different fixes.
   */
  anyUsableProvider: boolean;
  provider: SettingsProvider | null;
  model: string;
  modelInputModalities: ModelInputModality[];
  /** How hard the new thread should think. */
  reasoningEffort: ReasoningEffort;
  /**
   * Whether the selected model can reason. `null` = UNKNOWN.
   *
   * The composer shows the effort control only on `true` — we do not offer a
   * control for a model we cannot vouch for — while the SERVER withholds
   * reasoning only on `false`. The asymmetry is deliberate; see the design spec.
   */
  modelSupportsReasoning: boolean | null;
  /** What the selected model accepts for tuning reasoning. `undefined` =
   *  unknown, which keeps the full set of levels; `[]` = nothing tunable. */
  modelReasoningControls: ReasoningControl[] | undefined;
}

export function deriveNewChatModelState(settings: AgentSettingsResponse): NewChatModelState {
  // A provider curated down to zero models has nothing to start a chat with, so
  // it is out of the running entirely here — including as the fallback. A new
  // chat should never open on a provider whose picker would be empty, even when
  // the workspace's default agent points at it.
  const usable = settings.providers.filter((provider) => provider.usable);
  const providers = usable.filter(hasOfferableModels);
  const agentProvider = isSettingsProvider(settings.agent.provider)
    ? settings.agent.provider
    : null;
  const provider =
    agentProvider && providers.some((entry) => entry.provider === agentProvider)
      ? agentProvider
      : (providers[0]?.provider ?? null);

  return {
    providers,
    anyUsableProvider: usable.length > 0,
    provider,
    model:
      provider === agentProvider
        ? settings.agent.model
        : provider
          ? defaultModelForProvider(provider)
          : "",
    modelInputModalities:
      provider === agentProvider ? settings.agent.modelInputModalities : ["text"],
    reasoningEffort: settings.agent.reasoningEffort,
    // Only meaningful for the agent's own model; any other provider's default
    // model is a different model whose capability we have not looked up.
    modelSupportsReasoning:
      provider === agentProvider ? settings.agent.modelSupportsReasoning : null,
    modelReasoningControls: undefined,
  };
}

export function emptyNewChatModelState(): NewChatModelState {
  return {
    providers: [],
    anyUsableProvider: false,
    provider: null,
    model: "",
    modelInputModalities: ["text"],
    reasoningEffort: "medium",
    modelSupportsReasoning: null,
    modelReasoningControls: undefined,
  };
}

const MODEL_INPUT_MODALITIES: ModelInputModality[] = ["text", "image", "audio", "video", "file"];

/** `agents.model_input_modalities` is a JSON array stored as TEXT. Anything
 *  unparseable or empty falls back to text-only rather than throwing. */
function parseStoredModalities(raw: string): ModelInputModality[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return ["text"];
    const modalities = parsed.filter((entry): entry is ModelInputModality =>
      MODEL_INPUT_MODALITIES.includes(entry as ModelInputModality),
    );
    return modalities.length > 0 ? modalities : ["text"];
  } catch {
    return ["text"];
  }
}

/**
 * Re-seed the composer from the agent the user just picked.
 *
 * An agent carries its OWN provider, model and reasoning effort. Without this,
 * picking "Docs" in the new-chat picker sent the workspace default agent's
 * model with the POST — and the server honours an explicit model, so the thread
 * really did run on the wrong one. The server half of the same fix
 * (`selectThreadModelSnapshotTarget`) only covers a request that omits them.
 *
 * Returns `current` UNCHANGED when the agent's provider is not one this
 * composer can offer (no credentials, or curated down to zero models). Nothing
 * better is available: forcing an unusable provider into the composer would
 * make the send button refuse, and silently substituting a usable one is the
 * very substitution this fix exists to stop.
 */
export function selectNewChatAgentModel(
  agent: {
    provider: string;
    model: string;
    modelInputModalities: string;
    reasoningEffort: string;
    modelSupportsReasoning: boolean | null;
  },
  current: NewChatModelState,
): NewChatModelState {
  if (!isSettingsProvider(agent.provider)) return current;
  if (!current.providers.some((entry) => entry.provider === agent.provider)) return current;
  return {
    ...current,
    provider: agent.provider,
    model: agent.model,
    modelInputModalities: parseStoredModalities(agent.modelInputModalities),
    reasoningEffort: isReasoningEffort(agent.reasoningEffort)
      ? agent.reasoningEffort
      : current.reasoningEffort,
    modelSupportsReasoning: agent.modelSupportsReasoning,
    // The picker has not reported on THIS model yet; unknown, not "none".
    modelReasoningControls: undefined,
  };
}

export function selectNewChatProvider(
  provider: SettingsProvider,
  current: NewChatModelState,
): NewChatModelState {
  return {
    ...current,
    provider,
    model: defaultModelForProvider(provider),
    modelInputModalities: ["text"],
    // A different provider's default model is a different model: its capability
    // is unknown until the picker reports one, so the control hides rather than
    // carrying the previous model's answer over.
    modelSupportsReasoning: null,
    modelReasoningControls: undefined,
  };
}

export function typeNewChatModel(model: string, current: NewChatModelState): NewChatModelState {
  return {
    ...current,
    model,
    modelInputModalities: ["text"],
    modelSupportsReasoning: null,
    modelReasoningControls: undefined,
  };
}

export function selectNewChatModelModalities(
  modelInputModalities: ModelInputModality[],
  current: NewChatModelState,
): NewChatModelState {
  return {
    ...current,
    modelInputModalities,
  };
}

/** Records what the picker reported for the chosen model. `undefined` on the
 *  model record means unknown, which is stored as `null`. */
export function selectNewChatModelReasoning(
  reasoning: boolean | undefined,
  current: NewChatModelState,
  controls?: ReasoningControl[] | undefined,
): NewChatModelState {
  return {
    ...current,
    modelSupportsReasoning: reasoning ?? null,
    modelReasoningControls: controls,
  };
}

export function setNewChatReasoningEffort(
  reasoningEffort: ReasoningEffort,
  current: NewChatModelState,
): NewChatModelState {
  return { ...current, reasoningEffort };
}

export function canStartNewChat(state: Pick<NewChatModelState, "provider" | "model">): boolean {
  return state.provider !== null && state.model.trim().length > 0;
}
