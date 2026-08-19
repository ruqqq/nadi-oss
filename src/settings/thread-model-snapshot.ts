import type { Env } from "../env";
import {
  DEFAULT_REASONING_EFFORT,
  parseReasoningEffort,
  type ReasoningEffort,
} from "../agent/reasoning-options";
import {
  isSupportedAgentProvider,
  isUsableProviderForWorkspace,
  parseModelInputModalities,
  parseStoredModelInputModalities,
} from "./model-selection";

/**
 * Response-free core of thread model-snapshot resolution, shared by the HTTP
 * route (which maps errors to `Response`s) and the thread Durable Object
 * (which cannot construct a `Response` and needs the error code instead).
 */

export type ThreadModelSnapshotTarget = {
  workspaceId: string;
  provider: string;
  model: string;
  modelInputModalities: string;
  showReasoning: boolean;
  reasoningEffort: string;
  modelSupportsReasoning: boolean | null;
};

export type ThreadModelSnapshotValue = {
  provider: string;
  model: string;
  modelInputModalities: string[];
  showReasoning: boolean;
  reasoningEffort: ReasoningEffort;
  modelSupportsReasoning: boolean | null;
};

export type ThreadModelSnapshotError =
  | "malformed_body"
  | "unsupported_provider"
  | "provider_not_usable"
  | "invalid_model"
  | "invalid_modalities"
  | "invalid_show_reasoning"
  | "invalid_reasoning_effort"
  | "invalid_model_supports_reasoning";

type ThreadModelSnapshotInput = {
  provider?: unknown;
  model?: unknown;
  modelInputModalities?: unknown;
  showReasoning?: unknown;
  reasoningEffort?: unknown;
  modelSupportsReasoning?: unknown;
};

export async function resolveThreadModelSnapshotValue(
  env: Env,
  target: ThreadModelSnapshotTarget,
  body: unknown,
  viewerEmail: string | null | undefined,
): Promise<
  { ok: true; value: ThreadModelSnapshotValue } | { ok: false; error: ThreadModelSnapshotError }
> {
  if (body !== null && (typeof body !== "object" || Array.isArray(body))) {
    return { ok: false, error: "malformed_body" };
  }
  const input = (body ?? {}) as ThreadModelSnapshotInput;

  let provider = target.provider;
  if (input.provider !== undefined) {
    if (typeof input.provider !== "string" || !isSupportedAgentProvider(input.provider)) {
      return { ok: false, error: "unsupported_provider" };
    }
    provider = input.provider;
  }

  if (!(await isUsableProviderForWorkspace(env, target.workspaceId, provider, viewerEmail))) {
    return { ok: false, error: "provider_not_usable" };
  }

  let model = target.model;
  if (input.model !== undefined) {
    if (typeof input.model !== "string" || !input.model.trim()) {
      return { ok: false, error: "invalid_model" };
    }
    model = input.model.trim();
  }

  let modelInputModalities = parseStoredModelInputModalities(target.modelInputModalities);
  if (input.modelInputModalities !== undefined) {
    const parsed = parseModelInputModalities(input.modelInputModalities);
    if (!parsed) {
      return { ok: false, error: "invalid_modalities" };
    }
    modelInputModalities = parsed;
  }

  let showReasoning = target.showReasoning;
  if (input.showReasoning !== undefined) {
    if (typeof input.showReasoning !== "boolean") {
      return { ok: false, error: "invalid_show_reasoning" };
    }
    showReasoning = input.showReasoning;
  }

  let reasoningEffort = parseReasoningEffort(target.reasoningEffort) ?? DEFAULT_REASONING_EFFORT;
  if (input.reasoningEffort !== undefined) {
    const parsed = parseReasoningEffort(input.reasoningEffort);
    if (parsed === null) {
      return { ok: false, error: "invalid_reasoning_effort" };
    }
    reasoningEffort = parsed;
  }

  // Defaults to the agent's recorded capability, NOT to false: an unrecognised
  // model is unknown, and only an explicit false withholds reasoning at turn time.
  let modelSupportsReasoning = target.modelSupportsReasoning;
  if (input.modelSupportsReasoning !== undefined) {
    if (
      input.modelSupportsReasoning !== null &&
      typeof input.modelSupportsReasoning !== "boolean"
    ) {
      return { ok: false, error: "invalid_model_supports_reasoning" };
    }
    modelSupportsReasoning = input.modelSupportsReasoning;
  }

  return {
    ok: true,
    value: {
      provider,
      model,
      modelInputModalities,
      showReasoning,
      reasoningEffort,
      modelSupportsReasoning,
    },
  };
}
