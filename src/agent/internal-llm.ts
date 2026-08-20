import { streamText } from "ai";
import type { LanguageModel } from "ai";
import { log } from "../log";
import { buildModel } from "../providers/model-factory";
import type { Env } from "../env";
import type { StepUsage } from "./usage-recorder";

/**
 * Internal (non-conversational) LLM calls: thread auto-naming, compaction
 * summaries. These are OUR calls, not the user's turn.
 *
 * Two rules, both learned the hard way in production:
 *
 * 1. **Stream, don't generate.** These used to call `generateText`, which is a
 *    NON-streaming request. But the only path every model in the catalog is
 *    proven to serve is the streaming one — that is how chat works, so it is the
 *    only transport exercised for each provider in production. `generateText` was
 *    an untested contract on every model we ship, and it duly broke: the OpenAI
 *    Responses backend (openai-oauth / codex) returns `AI_APICallError: Invalid
 *    JSON response` for it. On a thread whose model cannot serve it, compaction
 *    could never run, so the thread grew until the provider rejected it.
 *
 * 2. **Fall back once, to a model we control.** Even over streaming, a thread's
 *    model can be rate-limited, capacity-limited, or briefly broken — and an
 *    internal call failing must not take compaction down with it. The fallback is
 *    a single keyless Workers AI model, NOT a per-provider mapping: it
 *    authenticates via the account's `AI` binding, so it needs no workspace
 *    secret and no configuration.
 */

/** Keyless (account `AI` binding), no workspace secret, no per-provider config. */
export const INTERNAL_FALLBACK_MODEL = "@cf/zai-org/glm-5.2";

/** One provider call that actually happened — billed whether or not we used its text. */
export interface InternalTextAttempt {
  provider: string;
  model: string;
  usage: StepUsage;
}

export interface InternalTextResult {
  text: string;
  usage: StepUsage;
  /**
   * The provider/model that ACTUALLY served the call — the fallback is a
   * different model, and the ledger must not lie about it.
   */
  provider: string;
  model: string;
  usedFallback: boolean;
  /**
   * EVERY call made, in order, each against the model that ran it. A primary that
   * returns empty text (or dies mid-stream) has still been billed for its input;
   * on a compaction prompt that is ~100k tokens. Callers must record all of these,
   * not just the one whose text they kept — tokens never written down cannot be
   * backfilled. Empty when no provider was reached at all (e.g. no AI binding).
   */
  attempts: InternalTextAttempt[];
}

const EMPTY_USAGE: StepUsage = {};

/** True when the provider reported no usage at all — i.e. no call was billed. */
function hasUsage(usage: StepUsage | undefined): usage is StepUsage {
  if (!usage) return false;
  return (
    typeof usage.inputTokens === "number" ||
    typeof usage.outputTokens === "number" ||
    typeof usage.cachedInputTokens === "number" ||
    typeof usage.reasoningTokens === "number"
  );
}

async function collectStream(input: {
  model: LanguageModel;
  system: string;
  prompt: string;
  maxOutputTokens?: number;
}): Promise<{ text: string; usage: StepUsage; error?: unknown }> {
  const result = streamText({
    model: input.model,
    system: input.system,
    prompt: input.prompt,
    ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
  });
  let text = "";
  let error: unknown;
  try {
    for await (const delta of result.textStream) text += delta;
  } catch (e) {
    // A mid-stream failure has ALREADY been billed for its input. Keep going and
    // read whatever usage the provider did report, then let the caller decide.
    error = e;
  }
  // `usage` resolves only once the stream is fully drained — which it now is.
  const usage = await Promise.resolve(result.usage).catch(() => undefined);
  return {
    text: text.trim(),
    ...(error === undefined ? {} : { error }),
    usage: {
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      cachedInputTokens: usage?.cachedInputTokens,
      reasoningTokens: usage?.reasoningTokens,
      // Carried through even though today's providers report it via
      // providerMetadata instead: a live probe (Task 1) showed a v3-class
      // model CAN put cache-write tokens here, and dropping the field would
      // silently zero that accounting the day one does.
      inputTokenDetails: usage?.inputTokenDetails,
    },
  };
}

/**
 * Run an internal LLM call on the thread's own model, falling back to
 * {@link INTERNAL_FALLBACK_MODEL} if that model cannot serve it.
 *
 * Returns "" only when BOTH the thread model and the fallback fail — callers
 * decide what an empty result means (auto-naming has a heuristic title;
 * compaction reports a real failure rather than a silent no-op).
 */
export async function generateInternalText(input: {
  env: Env;
  purpose: string;
  buildPrimary: () => Promise<LanguageModel>;
  /** Replaces `primaryLabel` — the ledger needs provider and model separately. */
  primaryProvider: string;
  primaryModel: string;
  system: string;
  prompt: string;
  maxOutputTokens?: number;
}): Promise<InternalTextResult> {
  const primaryLabel = `${input.primaryProvider}/${input.primaryModel}`;
  // Every call actually made, billed or not — appended as it happens, so no path
  // out of this function can forget one.
  const attempts: InternalTextAttempt[] = [];
  const record = (provider: string, model: string, usage: StepUsage | undefined): void => {
    if (hasUsage(usage)) attempts.push({ provider, model, usage });
  };

  try {
    const { text, usage, error } = await collectStream({
      model: await input.buildPrimary(),
      system: input.system,
      prompt: input.prompt,
      ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
    });
    record(input.primaryProvider, input.primaryModel, usage);
    if (error !== undefined) throw error;
    if (text.length > 0) {
      return {
        text,
        usage,
        provider: input.primaryProvider,
        model: input.primaryModel,
        usedFallback: false,
        attempts,
      };
    }
    log.warn("internal_llm.empty", { purpose: input.purpose, model: primaryLabel });
  } catch (error) {
    log.warn("internal_llm.primary_failed", {
      purpose: input.purpose,
      model: primaryLabel,
      error: String(error),
    });
  }

  const binding = input.env.AI;
  if (!binding) {
    log.warn("internal_llm.fallback_unavailable", {
      purpose: input.purpose,
      reason: "no_ai_binding",
    });
    return {
      text: "",
      usage: EMPTY_USAGE,
      provider: input.primaryProvider,
      model: input.primaryModel,
      usedFallback: false,
      attempts,
    };
  }

  try {
    // Deliberately bypasses the provider allowlist gate. That gate stops a
    // de-allowlisted USER from spending our budget on a provider they chose;
    // here WE choose the model, and we accept the (small, failure-only) cost so
    // that a thread on a broken model can still be summarized.
    const fallback = buildModel({
      provider: "workers-ai",
      model: INTERNAL_FALLBACK_MODEL,
      apiKey: "",
      workersAI: { binding },
    });
    const { text, usage, error } = await collectStream({
      model: fallback,
      system: input.system,
      prompt: input.prompt,
      ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
    });
    record("workers-ai", INTERNAL_FALLBACK_MODEL, usage);
    if (error !== undefined) throw error;
    if (text.length > 0) {
      log.info("internal_llm.fallback_used", {
        purpose: input.purpose,
        failedModel: primaryLabel,
        fallbackModel: INTERNAL_FALLBACK_MODEL,
      });
      return {
        text,
        usage,
        provider: "workers-ai",
        model: INTERNAL_FALLBACK_MODEL,
        usedFallback: true,
        attempts,
      };
    }
    log.warn("internal_llm.fallback_empty", { purpose: input.purpose });
    return {
      text: "",
      usage: EMPTY_USAGE,
      provider: input.primaryProvider,
      model: input.primaryModel,
      usedFallback: false,
      attempts,
    };
  } catch (error) {
    log.warn("internal_llm.fallback_failed", {
      purpose: input.purpose,
      fallbackModel: INTERNAL_FALLBACK_MODEL,
      error: String(error),
    });
    return {
      text: "",
      usage: EMPTY_USAGE,
      provider: input.primaryProvider,
      model: input.primaryModel,
      usedFallback: false,
      attempts,
    };
  }
}
