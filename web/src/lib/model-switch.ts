/**
 * The web-side twin of the transcript's model-switch marker.
 *
 * Mirrors `src/agent/model-switch.ts` (the server's `MODEL_SWITCH_PART_TYPE`,
 * `ModelTuple`, `ModelSwitchData`, `modelSwitchPart`, `readModelSwitchPart`),
 * redeclared here because web and worker code build under separate tsconfigs
 * and share no runtime import (see `ComposerModelPicker`'s `ModelTuple` doc
 * for the same constraint). Keep the two in sync by hand.
 *
 * The part type stays `data-*` on purpose: `convertToModelMessages` drops
 * `data-*` parts unless given an explicit converter, so this marker is
 * structurally incapable of reaching a provider. That is exactly why it is
 * safe for the CLIENT to attach one on send — do not extend the pattern to
 * anything that can reach a model.
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
 * Equality is on the (provider, model) TUPLE, never on the provider alone —
 * matches the server's `sameModelTuple`. Used on send to decide whether the
 * pending model actually differs from the committed one before attaching a
 * marker.
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
