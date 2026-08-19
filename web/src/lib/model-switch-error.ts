/**
 * Turn a `setPendingModelSwitch` rejection into something a user can act on.
 *
 * The RPC already returns a precise code; the composer used to discard it and
 * show one generic toast for BOTH a validation rejection and a thrown RPC.
 * That cost a production tail session to answer "why did the switch fail" when
 * the answer was already on the wire — so every branch here keeps the raw code
 * in the text. It is the string a bug report will quote.
 */
const MODEL_SWITCH_ERROR_MESSAGES: Record<string, string> = {
  provider_not_usable:
    "That provider isn't set up for this workspace yet — add its key in Settings.",
  unsupported_provider: "That provider isn't supported.",
  invalid_model: "That model name isn't valid.",
  invalid_modalities: "That model's supported input types look wrong.",
  invalid_reasoning_effort: "That model's reasoning effort looks wrong.",
  invalid_model_supports_reasoning: "That model's reasoning support looks wrong.",
  invalid_show_reasoning: "That model's reasoning display setting looks wrong.",
  malformed_body: "The model choice was malformed.",
};

/** The server refused the switch and told us why. */
export function modelSwitchErrorMessage(code: string): string {
  const known = MODEL_SWITCH_ERROR_MESSAGES[code];
  return known ? `Couldn't switch models: ${known} (${code})` : `Couldn't switch models (${code}).`;
}

/**
 * The RPC never returned — a thrown method, a dropped socket, a Durable Object
 * reset mid-call. Deliberately worded differently from a rejection: the first
 * live failure of this feature was an unregistered `callable()`, which throws
 * here, and the shared wording hid that it was never a validation problem.
 */
export function modelSwitchUnreachableMessage(): string {
  return "Couldn't reach the server to switch models. Please try again.";
}
