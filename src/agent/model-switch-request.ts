import type { UIMessage } from "ai";
import { isSupportedAgentProvider, parseModelInputModalities } from "../settings/model-selection";

/**
 * The client's REQUEST to switch models, asserted on the message that
 * commits it — distinct from `model-switch.ts`'s `data-model-switch` PART,
 * which is the server's own MARKER of a switch it actually performed. This
 * type is the wire shape of `UIMessage.metadata` on an outgoing user
 * message (see `App.tsx`'s `handleSend`/`handleModelSwitchSelect`), never
 * persisted verbatim: `resolveThreadModelSnapshotValue` is what turns it
 * into something the thread can actually run on, and only a validated
 * result is ever written to `thread_index`.
 *
 * `modelInputModalities`/`modelSupportsReasoning` are both optional because
 * the picker doesn't always know a candidate model's modalities or
 * reasoning support — an omitted field inherits the thread's CURRENT value,
 * exactly like `resolveThreadModelSnapshotValue`'s `undefined`-body-field
 * handling.
 */
export type ModelSwitchRequest = {
  provider: string;
  model: string;
  modelInputModalities?: string[];
  modelSupportsReasoning?: boolean;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Structural parse only — this does NOT decide whether the switch is
 * ALLOWED (that is `resolveThreadModelSnapshotValue`'s job, run once at
 * commit time). A malformed shape degrades to "no request" rather than
 * throwing: this reads a client-controlled wire value, same trust level as
 * `queued-user-messages.ts`'s `readStoredModelSwitch`, which this replaces
 * as the queue's own parser (see `modelSwitchRequestFromMessage` below).
 */
export function readModelSwitchRequest(value: unknown): ModelSwitchRequest | null {
  if (!isObject(value)) return null;
  const { provider, model, modelInputModalities, modelSupportsReasoning } = value;
  if (typeof provider !== "string" || !provider || !isSupportedAgentProvider(provider)) {
    return null;
  }
  if (typeof model !== "string" || !model) return null;

  const request: ModelSwitchRequest = { provider, model };
  if (modelInputModalities !== undefined) {
    const parsed = parseModelInputModalities(modelInputModalities);
    if (!parsed) return null;
    request.modelInputModalities = parsed;
  }
  if (modelSupportsReasoning !== undefined) {
    if (typeof modelSupportsReasoning !== "boolean") return null;
    request.modelSupportsReasoning = modelSupportsReasoning;
  }
  return request;
}

/** Reads a switch request off a UIMessage's `metadata` — the channel the
 *  client rides its request on, for both send paths (see the module doc). */
export function modelSwitchRequestFromMessage(message: UIMessage): ModelSwitchRequest | null {
  return readModelSwitchRequest(message.metadata);
}

/**
 * Picks the request that should drive a commit out of a turn's TRAILING
 * user messages — the run of user messages this turn just appended: one for
 * a direct send, several for a flushed queued batch (Think applies a
 * submission's whole message array, then runs one turn over all of it). The
 * scan stops at the first non-user message, same trailing-run shape
 * `trailingUserMessageIds` uses elsewhere in `think-thread-agent.ts`.
 *
 * Last one wins: the user's most recent expressed intent, applied uniformly
 * across BOTH send paths (direct and flushed-queue) from one scan, since
 * both carry their request the same way (on the message itself). This is
 * the ONE place that rule is decided — `queued-user-messages.ts` has no
 * selection logic of its own; an item's stored `modelSwitch` there is
 * preview/storage only, read by this scan once Think applies the batch.
 */
export function effectiveModelSwitchRequest(
  messages: readonly UIMessage[],
): ModelSwitchRequest | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== "user") break;
    const request = modelSwitchRequestFromMessage(message);
    if (request) return request;
  }
  return null;
}
