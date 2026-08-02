// src/http/debug-vision.ts
//
// Support for the token-gated vision probe (/api/debug/ai/vision). Kept out of
// debug-routes.ts so the input-shaping and output-scoring logic is unit-testable
// without constructing a Request.
//
// Every knob is overridable because the point of the probe is to discover a
// model's real contract, not to assert the one we already assume. `params` is
// merged over the defaults verbatim, so an undocumented field
// (repetition_penalty, top_p, …) can be tried without a code change.
import { arrayBufferToBase64 } from "../agent/attachment-extraction";

export const DEFAULT_VISION_MODEL = "@cf/moondream/moondream3.1-9B-A2B";

/** Matches what createAttachmentExtractor sends, so a probe reproduces prod. */
export const DEFAULT_VISION_PARAMS: Record<string, unknown> = {
  max_tokens: 2048,
  reasoning: false,
  stream: false,
  task: "query",
  temperature: 0,
};

/**
 * Vision models disagree on how bytes arrive: moondream takes a base64 data
 * URI on a top-level `image`, llava a plain number array, and the chat-style
 * multimodal models (llama-4-scout, gemma-4, kimi) an OpenAI-shaped `messages`
 * array with an `image_url` part. Cross-model comparison is impossible without
 * choosing per run.
 */
export type ImageFormat = "dataUri" | "byteArray" | "chatMessages";

/** `AI.toMarkdown()` is not a model, but it is the incumbent alternative. */
export const TO_MARKDOWN = "toMarkdown";

export type VisionProbeConfig = {
  model: string;
  question: string;
  imageFormat: ImageFormat;
  params: Record<string, unknown>;
};

/** Placeholders substituted anywhere inside a caller-supplied `rawInput`. */
export const IMAGE_DATA_URI = "{{IMAGE_DATA_URI}}";
export const IMAGE_BASE64 = "{{IMAGE_BASE64}}";
export const IMAGE_BYTES = "{{IMAGE_BYTES}}";

/**
 * Substitutes image placeholders into an arbitrary input tree, so a caller can
 * probe an undocumented request shape without shipping code for each guess.
 * Cloudflare documents an image field for three image-to-text models and
 * nothing for the chat-style multimodal ones, so guessing is unavoidable —
 * what is avoidable is a deploy per guess.
 */
export function substituteImage(
  value: unknown,
  parts: { dataUri: string; base64: string; bytes: number[] },
): unknown {
  if (value === IMAGE_DATA_URI) return parts.dataUri;
  if (value === IMAGE_BASE64) return parts.base64;
  if (value === IMAGE_BYTES) return parts.bytes;
  if (Array.isArray(value)) return value.map((item) => substituteImage(item, parts));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        substituteImage(item, parts),
      ]),
    );
  }
  return value;
}

export function imageParts(
  buffer: ArrayBuffer,
  mimeType: string,
): { dataUri: string; base64: string; bytes: number[] } {
  const base64 = arrayBufferToBase64(buffer);
  return {
    dataUri: `data:${mimeType};base64,${base64}`,
    base64,
    bytes: [...new Uint8Array(buffer)],
  };
}

export function buildVisionInput(
  buffer: ArrayBuffer,
  mimeType: string,
  config: VisionProbeConfig,
): Record<string, unknown> {
  const dataUri = `data:${mimeType};base64,${arrayBufferToBase64(buffer)}`;

  if (config.imageFormat === "chatMessages") {
    // `task` and `reasoning` are moondream-only knobs; a chat model rejects the
    // request outright rather than ignoring them, so they are dropped here
    // instead of being every caller's problem.
    const { task: _task, reasoning: _reasoning, ...params } = config.params;
    return {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: config.question },
            { type: "image_url", image_url: { url: dataUri } },
          ],
        },
      ],
      ...params,
    };
  }

  const image = config.imageFormat === "byteArray" ? [...new Uint8Array(buffer)] : dataUri;
  // params last: an explicit override always wins over a default, including
  // stream:false, which a caller may genuinely want to flip to inspect SSE.
  return { image, prompt: config.question, question: config.question, ...config.params };
}

/**
 * Pulls the text out of whatever shape a model returns. Moondream answers under
 * `result.answer` — except in `task:"caption"`, where `answer` is null and the
 * text is under `result.caption` — and llava uses `description`. A probe that
 * checks only one key reports a working mode as empty, so every known key is
 * tried before giving up.
 */
export function answerFromVision(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const nested = record.result;
  const scopes = [record, typeof nested === "object" && nested !== null ? nested : null];
  for (const scope of scopes) {
    if (!scope) continue;
    for (const key of ["answer", "caption", "description", "response", "text", "output"]) {
      const value = (scope as Record<string, unknown>)[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
    // Chat-style models answer under choices[0]; Workers AI uses a bare `text`
    // on the choice rather than OpenAI's nested `message.content`, so both are
    // read — reporting a working model as empty is the failure mode here.
    const choices = (scope as Record<string, unknown>).choices;
    if (Array.isArray(choices)) {
      const choice = choices[0] as { text?: unknown; message?: { content?: unknown } } | undefined;
      if (typeof choice?.text === "string" && choice.text.length > 0) return choice.text;
      const content = choice?.message?.content;
      if (typeof content === "string" && content.length > 0) return content;
    }
  }
  return null;
}

export type AnswerAnalysis = {
  chars: number;
  words: number;
  realChars: number;
  repetitionTailChars: number;
  repetitionRatio: number;
  /**
   * Share of 6-word windows that are distinct. 1 means no phrase repeats; a low
   * value means the model looped. The char-tail metric alone scored a run that
   * repeated "The top post shows 'marriagefamiliah'" seventeen times as
   * perfectly clean, which is exactly the judgement this is here to prevent.
   */
  uniqueNgramRatio: number;
  finishReason: unknown;
  usage: unknown;
};

function uniqueNgramRatio(text: string, size = 6): number {
  const words = text.toLowerCase().match(/[a-z']+/g) ?? [];
  if (words.length < size) return 1;
  const grams = new Set<string>();
  const total = words.length - size + 1;
  for (let i = 0; i < total; i += 1) grams.add(words.slice(i, i + size).join(" "));
  return grams.size / total;
}

/**
 * Small vision models degenerate into a repeated-token loop and run to the
 * token cap — 53% of a real moondream transcription was a trailing emoji run.
 * Scoring that tail is the difference between "produced 1180 characters" and
 * "produced 554 useful ones", which raw length hides.
 */
export function analyzeAnswer(answer: string | null, raw: unknown): AnswerAnalysis {
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const nested =
    typeof record.result === "object" && record.result !== null
      ? (record.result as Record<string, unknown>)
      : {};
  const finishReason = record.finish_reason ?? nested.finish_reason ?? null;
  const usage = record.usage ?? nested.usage ?? null;

  const text = answer ?? "";
  // The tail is everything after the last ASCII letter: a degeneration loop is
  // emoji or punctuation, so the last real word marks where output stopped
  // carrying information.
  let lastLetter = -1;
  for (let i = text.length - 1; i >= 0; i -= 1) {
    const code = text.charCodeAt(i);
    if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
      lastLetter = i;
      break;
    }
  }
  const realChars = lastLetter + 1;
  const repetitionTailChars = text.length - realChars;
  return {
    chars: text.length,
    words: (text.match(/[A-Za-z']+/g) ?? []).length,
    realChars,
    repetitionTailChars,
    repetitionRatio: text.length > 0 ? repetitionTailChars / text.length : 0,
    uniqueNgramRatio: uniqueNgramRatio(text),
    finishReason,
    usage,
  };
}
