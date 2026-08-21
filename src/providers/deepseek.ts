// src/providers/deepseek.ts
//
// DeepSeek is CONFIGURED on the generic OpenAI-compatible adapter, not adapted
// by `@ai-sdk/deepseek`.
//
// That package cannot send an image. Its converter flattens every user message
// to a plain string and turns any file part into an `unsupported` warning
// nothing reads (same code in the installed 2.0.51 and in 3.0.29, the latest
// release). `deepseek-v4-flash-vision-exp` therefore advertised vision, took an
// attachment, and received text only — the model answered a riddle sheet by
// installing tesseract in its sandbox and OCRing the JPEG it had been handed a
// URL for. The generic adapter emits `image_url` (data URI or link), so the
// image reaches the model.
//
// Two things the vendor package did have to be reproduced here. Reasoning
// options do NOT: the generic adapter already emits `reasoning_effort` from
// `reasoningEffort` and spreads `thinking` through verbatim (a mutation test
// that stayed green proved the rename hop we first wrote was dead code). What
// it does not do is:
//
//   1. Suppress the effort when thinking is explicitly disabled, and stamp
//      `reasoning_content: ""` on assistant messages for `deepseek-v4*`.
//   2. Read cache accounting from DeepSeek's own `prompt_cache_hit_tokens`
//      rather than `prompt_tokens_details.cached_tokens`.
//
// `supportedUrls` is deliberately left empty: the AI SDK core then downloads a
// managed attachment and inlines it as base64, so a presigned R2 URL — valid
// for days — is never handed to a third party. DeepSeek documents both forms.
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { JSONValue, LanguageModel } from "ai";

type Usage = {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  prompt_cache_hit_tokens?: number | null;
  prompt_tokens_details?: { cached_tokens?: number | null } | null;
  completion_tokens_details?: { reasoning_tokens?: number | null } | null;
} | null;

type WireMessage = { role?: unknown; reasoning_content?: unknown };

export function createDeepSeekModel(input: {
  model: string;
  apiKey: string;
  baseURL: string;
  fetch?: typeof fetch;
}): LanguageModel {
  const settings: Parameters<typeof createOpenAICompatible>[0] = {
    name: "deepseek",
    apiKey: input.apiKey,
    baseURL: input.baseURL,
    transformRequestBody: transformDeepSeekRequestBody,
    convertUsage: convertDeepSeekUsage,
  };
  if (input.fetch !== undefined) settings.fetch = input.fetch;
  return createOpenAICompatible(settings).chatModel(input.model) as LanguageModel;
}

/** The last hop before the request body is serialized. */
export function transformDeepSeekRequestBody(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...args };

  // An explicit disable wins over an effort value; the vendor adapter suppressed
  // the pair the same way, and DeepSeek documents `thinking` as the off switch
  // whatever the effort says.
  const thinking = body.thinking as { type?: unknown } | null | undefined;
  if (thinking?.type === "disabled") delete body.reasoning_effort;

  if (isDeepSeekV4(body.model) && Array.isArray(body.messages)) {
    body.messages = body.messages.map((message) => {
      const wire = message as WireMessage;
      if (wire?.role !== "assistant" || wire.reasoning_content != null) return message;
      return { ...(message as object), reasoning_content: "" };
    });
  }

  return body;
}

/**
 * DeepSeek reports cache reads on `prompt_cache_hit_tokens`. Reading only
 * OpenAI's `prompt_tokens_details.cached_tokens` would silently record every
 * turn as a full-price cache miss in `thread_token_usage`; both are honoured so
 * the accounting survives DeepSeek adding the OpenAI-shaped field.
 */
export function convertDeepSeekUsage(rawUsage: unknown) {
  const usage = (rawUsage ?? null) as Usage;
  const promptTokens = usage?.prompt_tokens ?? 0;
  const completionTokens = usage?.completion_tokens ?? 0;
  const cacheRead =
    usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens ?? 0;

  return {
    inputTokens: {
      total: promptTokens,
      noCache: promptTokens - cacheRead,
      cacheRead,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: completionTokens,
      text: completionTokens - reasoningTokens,
      reasoning: reasoningTokens,
    },
    ...(usage ? { raw: usage as unknown as Record<string, JSONValue> } : {}),
  };
}

function isDeepSeekV4(model: unknown): boolean {
  return typeof model === "string" && model.includes("deepseek-v4");
}
