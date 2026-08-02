// src/agent/prepare-attachments.ts
import type { ModelMessage, UIMessage } from "ai";
import { log } from "../log";

export const ATTACHMENT_URL_RE = /^\/api\/attachments\/([^/]+)$/;

export type PrepareOpts = {
  inputModalities: string[];
  resolveAttachment: (
    id: string,
  ) => Promise<{ r2Key: string; mimeType: string; filename: string | null } | null>;
  presign: (r2Key: string) => Promise<string>;
  /**
   * Derives text for an attachment the model cannot read natively. `null` means
   * the MIME type is not extractable. Absent when the AI binding is unbound —
   * behavior then reverts exactly to `attachmentStub`.
   *
   * `query` is the text the user sent in the same message as the attachment, so
   * the extractor can attempt an answer alongside the transcription. Images
   * only — toMarkdown takes no prompt.
   */
  extract?: (attachmentId: string, query?: string) => Promise<ExtractionResult | null>;
};

const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

const OMITTED_TEXT_PART = {
  type: "text" as const,
  text: "[attachment omitted: not supported by the current model]",
};

export const INLINE_MAX_CHARS = 12_000;

export type ExtractionSource =
  | "workers-ai-tomarkdown"
  | "workers-ai-llama-vision"
  // Retired 2026-08-02. Only new rows stop using it; rows written before the
  // switch still carry it and must keep rendering a label.
  | "workers-ai-moondream";
export type ExtractionResult = { text: string; source: ExtractionSource } | { error: string };

const SOURCE_LABEL: Record<ExtractionSource, string> = {
  "workers-ai-tomarkdown": "Workers AI (toMarkdown)",
  "workers-ai-llama-vision": "Workers AI (Llama 4 Scout)",
  "workers-ai-moondream": "Workers AI (Moondream)",
};

const EXTRACTION_FAILED_NOTE = " Automatic extraction of this attachment failed.";

export function formatGeneratedContext(args: {
  id: string;
  filename: string | null;
  text: string;
  source: ExtractionSource;
}): string {
  const name = args.filename ?? args.id;
  const total = args.text.length;
  const body = total > INLINE_MAX_CHARS ? args.text.slice(0, INLINE_MAX_CHARS) : args.text;
  const truncation =
    total > INLINE_MAX_CHARS
      ? `\n\n[truncated: ${INLINE_MAX_CHARS.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} characters — call getAttachmentUrl with id "${args.id}" for the full file]`
      : "";
  return [
    `[Generated context for attachment: ${name}]`,
    `Source: ${SOURCE_LABEL[args.source]}`,
    "",
    body + truncation,
    "[/Generated context]",
  ].join("\n");
}

function attachmentStub(id: string, filename: string | null, mimeType: string): string {
  const name = filename ?? id;
  return `📎 The user attached "${name}" (${mimeType}). It can't be read inline by the current model — call getAttachmentUrl with id "${id}" to get a temporary URL you can pass to another tool.`;
}

type PreparedAttachment =
  | { url: string; id: string; filename: string | null; mimeType: string }
  | { stub: string }
  | { context: string }
  | null;

/**
 * The text the user authored alongside an attachment, joined across every text
 * part of the same message. Computed once per message so two images in one
 * message share the question that was asked about them.
 */
function siblingQuery(texts: string[]): string | undefined {
  const joined = texts.join("\n\n").trim();
  return joined.length > 0 ? joined : undefined;
}

async function prepareManagedAttachment(
  attachmentId: string,
  opts: PrepareOpts,
  query?: string,
): Promise<PreparedAttachment> {
  try {
    const meta = await opts.resolveAttachment(attachmentId);
    if (!meta) return null; // unknown attachment: drop
    if (!selectedModelSupportsAttachment(opts.inputModalities, meta.mimeType)) {
      const extracted = opts.extract ? await opts.extract(attachmentId, query) : null;
      if (extracted && "text" in extracted) {
        return {
          context: formatGeneratedContext({
            id: attachmentId,
            filename: meta.filename,
            text: extracted.text,
            source: extracted.source,
          }),
        };
      }
      const stub = attachmentStub(attachmentId, meta.filename, meta.mimeType);
      return { stub: extracted ? stub + EXTRACTION_FAILED_NOTE : stub };
    }
    return {
      url: await opts.presign(meta.r2Key),
      id: attachmentId,
      filename: meta.filename,
      mimeType: meta.mimeType,
    };
  } catch (err) {
    // best-effort: drop on failure — never crash the turn
    log.warn("prepare_attachments.part_dropped", {
      attachmentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function selectedModelSupportsAttachment(inputModalities: string[], mimeType: string): boolean {
  if (IMAGE_MIME_TYPES.has(mimeType)) return inputModalities.includes("image");
  if (mimeType === "application/pdf") return inputModalities.includes("file");
  return false;
}

function pushUniqueAttachmentId(out: string[], value: unknown): void {
  if (typeof value !== "string") return;
  const match = value.match(ATTACHMENT_URL_RE);
  const id = match?.[1];
  if (id && !out.includes(id)) out.push(id);
}

export function extractAttachmentIdsFromUiMessages(messages: UIMessage[]): string[] {
  const ids: string[] = [];
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "file") pushUniqueAttachmentId(ids, part.url);
    }
  }
  return ids;
}

export function extractAttachmentIdsFromModelMessages(messages: ModelMessage[]): string[] {
  const ids: string[] = [];
  for (const message of messages) {
    if (!hasArrayContent(message)) continue;
    for (const part of message.content) {
      if (typeof part !== "object" || part === null) continue;
      const record = part as Record<string, unknown>;
      if (record.type === "file") pushUniqueAttachmentId(ids, record.data);
      if (record.type === "image") pushUniqueAttachmentId(ids, record.image);
    }
  }
  return ids;
}

export async function prepareMessagesForModel(
  messages: UIMessage[],
  opts: PrepareOpts,
): Promise<UIMessage[]> {
  return Promise.all(
    messages.map(async (message) => {
      const hadParts = message.parts.length > 0;
      const query = siblingQuery(
        message.parts.flatMap((part) =>
          part.type === "text" && typeof part.text === "string" ? [part.text] : [],
        ),
      );
      const parts = await Promise.all(
        message.parts.map(async (part) => {
          if (part.type !== "file" || typeof part.url !== "string") return part;
          const match = part.url.match(ATTACHMENT_URL_RE);
          if (!match) return part; // external/non-managed url: leave as-is
          const prepared = await prepareManagedAttachment(match[1]!, opts, query);
          if (prepared === null) return null;
          if ("context" in prepared) return { type: "text", text: prepared.context };
          if ("stub" in prepared) return { type: "text", text: prepared.stub };
          return { ...part, url: prepared.url };
        }),
      );
      const filtered = parts.filter((p) => p !== null) as UIMessage["parts"];
      // If all parts were dropped from a message that originally had parts, synthesise a
      // placeholder text part so providers that reject empty-content messages don't fail.
      if (hadParts && filtered.length === 0) {
        return { ...message, parts: [OMITTED_TEXT_PART] } as UIMessage;
      }
      return { ...message, parts: filtered } as UIMessage;
    }),
  );
}

type ModelMessageWithArrayContent = ModelMessage & { content: unknown[] };
type ModelContentPart = Record<string, unknown> & { type?: unknown };

function hasArrayContent(message: ModelMessage): message is ModelMessageWithArrayContent {
  return "content" in message && Array.isArray(message.content);
}

function attachmentReferencePart(attachment: {
  id: string;
  filename: string | null;
  mimeType: string;
}): { type: "text"; text: string } {
  const name = attachment.filename ?? attachment.id;
  return {
    type: "text",
    text: `Attachment reference: use id "${attachment.id}" for "${name}" (${attachment.mimeType}).`,
  };
}

async function prepareModelContentPart(
  part: unknown,
  opts: PrepareOpts,
  query?: string,
): Promise<unknown | unknown[] | null> {
  if (typeof part !== "object" || part === null) return part;
  const contentPart = part as ModelContentPart;

  if (contentPart.type === "file" && typeof contentPart.data === "string") {
    const match = contentPart.data.match(ATTACHMENT_URL_RE);
    if (!match) return part; // external/non-managed url or inline data: leave as-is
    const prepared = await prepareManagedAttachment(match[1]!, opts, query);
    if (prepared === null) return null;
    if ("context" in prepared) return { type: "text", text: prepared.context };
    if ("stub" in prepared) return { type: "text", text: prepared.stub };
    return [attachmentReferencePart(prepared), { ...contentPart, data: new URL(prepared.url) }];
  }

  if (contentPart.type === "image" && typeof contentPart.image === "string") {
    const match = contentPart.image.match(ATTACHMENT_URL_RE);
    if (!match) return part; // external/non-managed url or inline data: leave as-is
    const prepared = await prepareManagedAttachment(match[1]!, opts, query);
    if (prepared === null) return null;
    if ("context" in prepared) return { type: "text", text: prepared.context };
    if ("stub" in prepared) return { type: "text", text: prepared.stub };
    return [attachmentReferencePart(prepared), { ...contentPart, image: new URL(prepared.url) }];
  }

  return part;
}

export async function prepareModelMessagesForModel(
  messages: ModelMessage[],
  opts: PrepareOpts,
): Promise<ModelMessage[]> {
  return Promise.all(
    messages.map(async (message) => {
      if (!hasArrayContent(message)) return message;

      const content = message.content as unknown[];
      const hadParts = content.length > 0;
      const query = siblingQuery(
        content.flatMap((part) => {
          if (typeof part !== "object" || part === null) return [];
          const record = part as ModelContentPart;
          return record.type === "text" && typeof record.text === "string" ? [record.text] : [];
        }),
      );
      const parts = await Promise.all(
        content.map((part) => prepareModelContentPart(part, opts, query)),
      );
      const filtered = parts.flatMap((part) => {
        if (part === null) return [];
        return Array.isArray(part) ? part : [part];
      });

      if (hadParts && filtered.length === 0) {
        return { ...message, content: [OMITTED_TEXT_PART] } as ModelMessage;
      }

      return { ...message, content: filtered } as ModelMessage;
    }),
  );
}
