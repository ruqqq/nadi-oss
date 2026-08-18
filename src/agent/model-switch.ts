/**
 * The transcript's record of a model switch.
 *
 * Written as an AI SDK `data-*` part, which `convertToModelMessages` drops
 * unless given an explicit converter — so the marker is visible to the UI and
 * to the sanitizer, and structurally cannot reach a provider. Both properties
 * are load-bearing; `cross-model-reasoning-sanitize.test.ts` asserts the
 * second.
 */
export const MODEL_SWITCH_PART_TYPE = "data-model-switch" as const;

export interface ModelTuple {
  provider: string;
  model: string;
}

export interface ModelSwitchData {
  from: ModelTuple;
  to: ModelTuple;
}

export function modelSwitchPart(data: ModelSwitchData): {
  type: typeof MODEL_SWITCH_PART_TYPE;
  data: ModelSwitchData;
} {
  return { type: MODEL_SWITCH_PART_TYPE, data };
}

export function readModelSwitchPart(part: unknown): ModelSwitchData | null {
  if (!isRecord(part) || part.type !== MODEL_SWITCH_PART_TYPE) return null;
  const data = part.data;
  if (!isRecord(data)) return null;
  const from = readTuple(data.from);
  const to = readTuple(data.to);
  if (!from || !to) return null;
  return { from, to };
}

/**
 * Equality is on the (provider, model) TUPLE, never on the provider alone.
 * OpenRouter replays `reasoning_details` across upstream models inside a single
 * `openrouter` namespace, so a provider-only comparison would call an Anthropic
 * thinking block and a GPT turn the same origin.
 */
export function sameModelTuple(a: ModelTuple, b: ModelTuple): boolean {
  return a.provider === b.provider && a.model === b.model;
}

function readTuple(value: unknown): ModelTuple | null {
  if (!isRecord(value)) return null;
  const { provider, model } = value;
  if (typeof provider !== "string" || !provider) return null;
  if (typeof model !== "string" || !model) return null;
  return { provider, model };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
