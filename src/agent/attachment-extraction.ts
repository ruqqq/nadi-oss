// src/agent/attachment-extraction.ts
//
// Images go through llama-4-scout; documents still go through toMarkdown.
//
// Moondream held this job until 2026-08-02 and was replaced because it
// degenerated: at temperature 0 it emitted one repeated emoji until the token
// cap on 2 of 3 test images, scoring 0/10 ground-truth strings on a screenshot
// where scout scored 10/10. repetition_penalty is silently ignored, and at
// temperature 0 a retry reproduces the same loop, so no parameter fixed it.
//
// The chat contract below was found by probing (/api/debug/ai/vision) and is
// not documented. Two traps: `image_url` must be an OBJECT — a string is a
// validation error, and a top-level `image` beside `messages` is ignored so
// silently that the model hallucinates a whole document instead of failing.
// And moondream's old params (task/reasoning/temperature/stream) must NOT be
// sent: they break image delivery the same silent way.
import { log } from "../log";
import type { ExtractionResult, ExtractionSource } from "./prepare-attachments";

export const STORED_MAX_CHARS = 256_000;
export const MAX_ATTEMPTS = 2;
export const VISION_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
export const DEFAULT_EXTRACTION_QUESTION =
  "Transcribe all visible text verbatim, preserving layout and code. Then briefly describe non-text visual content. If no text is visible, say so.";
// A pasted wall of text would crowd the transcription out of the token budget.
export const MAX_QUERY_CHARS = 500;
export const EXTRACTION_MAX_TOKENS = 2048;
// The transcription budget must not shrink because an answer section now shares
// the response.
export const EXTRACTION_MAX_TOKENS_WITH_QUERY = 3072;

/**
 * Weaves the user's own question into the extraction prompt. Transcription
 * stays first and mandatory: the answer is the instruction a model is most
 * tempted to satisfy at the transcription's expense, and the transcription is
 * the part that gets cached and lives in history forever.
 */
export function buildExtractionQuestion(query?: string): string {
  const trimmed = query?.trim();
  if (!trimmed) return DEFAULT_EXTRACTION_QUESTION;
  const bounded =
    trimmed.length > MAX_QUERY_CHARS ? `${trimmed.slice(0, MAX_QUERY_CHARS)}…` : trimmed;
  return [
    "Respond in exactly two sections.",
    "First `## Transcription`: all visible text verbatim, preserving layout and code, then a brief description of non-text visual content. If no text is visible, say so.",
    `Then \`## Answer\`: using only what is visible in the image, answer this question from the user: «${bounded}». If the image does not show enough to answer, say so.`,
  ].join(" ");
}
// Bounds the burst when a thread with many attachments first meets a text-only
// model: prepare walks the whole history, so everything extracts at once.
export const MAX_CONCURRENT_EXTRACTIONS = 4;

/**
 * Global kill switch. toMarkdown costs 12-31s per image and that lands on the
 * first turn after an attachment, before the first token. Off unless the var is
 * exactly "true", so a missing or malformed value never silently enables it.
 */
export function isExtractionEnabled(flag: string | undefined): boolean {
  return flag === "true";
}

const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
// Subset of BINARY_DOCUMENT_MIME_BY_EXT that Workers AI toMarkdown can convert.
// EPUB is intentionally absent — it uploads, but extraction falls through to
// getAttachmentUrl rather than a failing toMarkdown call.
const DOCUMENT_MIME_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-excel",
  "application/vnd.ms-excel.sheet.macroenabled.12",
  "application/vnd.ms-excel.sheet.binary.macroenabled.12",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.apple.numbers",
]);

export function isExtractableMime(mimeType: string): boolean {
  return IMAGE_MIME_TYPES.has(mimeType) || DOCUMENT_MIME_TYPES.has(mimeType);
}

export type ExtractionRow = {
  id: string;
  mimeType: string;
  filename: string | null;
  r2Key: string;
  byteSize: number;
  extractedText: string | null;
  extractedSource: string | null;
  extractedError: string | null;
  extractedAttempts: number;
};

export type ExtractionStore = {
  load(id: string): Promise<ExtractionRow | null>;
  beginAttempt(id: string): Promise<void>;
  saveSuccess(id: string, text: string, source: ExtractionSource): Promise<void>;
  saveFailure(id: string, error: string): Promise<void>;
};

export type WorkersAi = {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
  toMarkdown(files: { name: string; blob: Blob }[]): Promise<{ data: string }[]>;
};

export type ExtractionDeps = { ai: WorkersAi; bucket: R2Bucket; store: ExtractionStore };

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * Workers AI puts chat output on `choices[0].text`, NOT on OpenAI's nested
 * `choices[0].message.content` — reading only the latter scores a working model
 * as empty. Both are read, plus the legacy `answer` shapes so a response from
 * the previous model still parses.
 */
export function answerFromVisionModel(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const nested = record.result;
  const scopes: Record<string, unknown>[] = [record];
  if (typeof nested === "object" && nested !== null) scopes.push(nested as Record<string, unknown>);

  for (const scope of scopes) {
    const choices = scope.choices;
    if (Array.isArray(choices)) {
      const choice = choices[0] as { text?: unknown; message?: { content?: unknown } } | undefined;
      if (typeof choice?.text === "string" && choice.text.length > 0) return choice.text;
      const content = choice?.message?.content;
      if (typeof content === "string" && content.length > 0) return content;
    }
    const answer = scope.answer;
    if (typeof answer === "string" && answer.length > 0) return answer;
    const response = scope.response;
    if (typeof response === "string" && response.length > 0) return response;
  }
  return null;
}

function createLimiter(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((resolve) => queue.push(resolve));
    active += 1;
    try {
      return await fn();
    } finally {
      active -= 1;
      queue.shift()?.();
    }
  };
}

export function createAttachmentExtractor(
  deps: ExtractionDeps,
): (attachmentId: string, query?: string) => Promise<ExtractionResult | null> {
  const limit = createLimiter(MAX_CONCURRENT_EXTRACTIONS);

  async function bytes(r2Key: string): Promise<ArrayBuffer> {
    const object = await deps.bucket.get(r2Key);
    if (!object) throw new Error("attachment bytes missing from R2");
    return object.arrayBuffer();
  }

  async function runVisionModel(row: ExtractionRow, query?: string): Promise<string> {
    const buffer = await bytes(row.r2Key);
    const trimmed = query?.trim();
    // messages + max_tokens ONLY. Any extra sampling param breaks image
    // delivery silently, and the model then describes an image it never saw.
    const raw = await deps.ai.run(VISION_MODEL, {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: buildExtractionQuestion(trimmed) },
            {
              type: "image_url",
              image_url: {
                url: `data:${row.mimeType};base64,${arrayBufferToBase64(buffer)}`,
              },
            },
          ],
        },
      ],
      max_tokens: trimmed ? EXTRACTION_MAX_TOKENS_WITH_QUERY : EXTRACTION_MAX_TOKENS,
    });
    const answer = answerFromVisionModel(raw);
    if (typeof answer !== "string" || answer.trim().length === 0) {
      // A reasoning model can spend its whole budget thinking and return empty
      // content. Caching that would poison the row permanently.
      throw new Error("vision model returned no content");
    }
    return answer;
  }

  async function runToMarkdown(row: ExtractionRow): Promise<string> {
    const buffer = await bytes(row.r2Key);
    const results = await deps.ai.toMarkdown([
      {
        name: row.filename ?? row.id,
        blob: new Blob([buffer], { type: row.mimeType }),
      },
    ]);
    const data = results[0]?.data;
    if (typeof data !== "string" || data.length === 0) {
      throw new Error("toMarkdown returned no content");
    }
    return data;
  }

  return async function extract(
    attachmentId: string,
    query?: string,
  ): Promise<ExtractionResult | null> {
    const row = await deps.store.load(attachmentId);
    if (!row || !isExtractableMime(row.mimeType)) return null;

    if (row.extractedText !== null) {
      return { text: row.extractedText, source: row.extractedSource as ExtractionSource };
    }
    if (row.extractedAttempts >= MAX_ATTEMPTS) {
      return { error: row.extractedError ?? "extraction failed" };
    }

    // Increment BEFORE the call: a Worker eviction mid-extraction must not
    // produce an unbounded retry loop across turns.
    await deps.store.beginAttempt(attachmentId);

    const isImage = IMAGE_MIME_TYPES.has(row.mimeType);
    const source: ExtractionSource = isImage ? "workers-ai-llama-vision" : "workers-ai-tomarkdown";

    try {
      const raw = await limit(() => (isImage ? runVisionModel(row, query) : runToMarkdown(row)));
      const text = raw.slice(0, STORED_MAX_CHARS);
      await deps.store.saveSuccess(attachmentId, text, source);
      return { text, source };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn("attachment_extraction.failed", {
        attachmentId,
        mimeType: row.mimeType,
        error: message,
      });
      await deps.store.saveFailure(attachmentId, message);
      return { error: message };
    }
  };
}
