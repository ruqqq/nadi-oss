import type { SettingsProvider } from "../settings-api";

/** A locally-held pending model switch: the tuple plus whatever the picker
 *  knew about the new model's modalities / reasoning support, so a re-render
 *  (or a repeated switch to the same model) doesn't have to re-derive them.
 *  `modelInputModalities`/`modelSupportsReasoning` are the same tri-state
 *  contract as `ThreadModelSnapshotValue` server-side: absent means inherit,
 *  never coerce to a default.
 *
 *  `provider`/`model` match `ComposerModelPicker`'s `ModelTuple` field for
 *  field (down to `SettingsProvider`, imported from `settings-api.ts` — a
 *  plain `.ts` module, unlike `ModelTuple` itself, which lives in a `.tsx`
 *  file the root worker tsconfig cannot resolve; see
 *  nadi-web-lib-typechecked-under-worker-tsconfig). Assignable both ways
 *  with `ModelTuple` at every call site in `App.tsx`. */
export type PendingModelSwitchValue = {
  provider: SettingsProvider;
  model: string;
  modelInputModalities?: string[];
  modelSupportsReasoning?: boolean;
};

/**
 * Builds the `UIMessage.metadata` value that carries a model-switch REQUEST
 * to the server — the wire shape `src/agent/model-switch-request.ts`'s
 * `readModelSwitchRequest` parses on the other end. Extracted out of
 * `App.tsx`'s `handleSend` so `test/unit/web/model-switch-parity.test.ts` can
 * feed the object the CLIENT actually builds through the server's real
 * parser, instead of a hand-copied literal that only proves the test agrees
 * with itself. `App.tsx` must call this — never re-inline the object.
 *
 * Returns `undefined` (not `null`) when there is no pending switch, matching
 * the `...(modelSwitchMetadata ? { metadata: modelSwitchMetadata } : {})`
 * spread at both call sites: an absent `metadata` key, not a `metadata:
 * undefined` one.
 */
export function buildModelSwitchMetadata(
  pendingModel: PendingModelSwitchValue | null,
): PendingModelSwitchValue | undefined {
  if (!pendingModel) return undefined;
  return {
    provider: pendingModel.provider,
    model: pendingModel.model,
    ...(pendingModel.modelInputModalities
      ? { modelInputModalities: pendingModel.modelInputModalities }
      : {}),
    ...(typeof pendingModel.modelSupportsReasoning === "boolean"
      ? { modelSupportsReasoning: pendingModel.modelSupportsReasoning }
      : {}),
  };
}
