import { tool } from "ai";
import { z } from "zod";
import { AttachmentRepository } from "../db/attachment-repository";
import {
  PRESIGN_EXPIRES_SECONDS,
  PRESIGN_WINDOW_MS,
  bucketedAnchorMs,
  presignDepsFromEnv,
  presignGet,
} from "../storage/r2-presign";
import type { Env } from "../env";

const EXTRACTED_TEXT_PREVIEW_CHARS = 4_000;

function attachmentExtractionForTool(
  row: Awaited<ReturnType<AttachmentRepository["listByThread"]>>[number],
) {
  if (row.extractedText) {
    const truncated = row.extractedText.length > EXTRACTED_TEXT_PREVIEW_CHARS;
    return {
      status: "available",
      source: row.extractedSource,
      text: truncated
        ? row.extractedText.slice(0, EXTRACTED_TEXT_PREVIEW_CHARS)
        : row.extractedText,
      truncated,
    };
  }
  if (row.extractedError) {
    return {
      status: "failed",
      error: row.extractedError,
    };
  }
  return {
    status: "unavailable",
  };
}

export function createAttachmentTools(deps: { env: Env; threadId: string }) {
  const repo = new AttachmentRepository(deps.env.REGISTRY_DB);
  return {
    listAttachments: tool({
      description:
        "List the files the user attached in the CURRENT conversation. Returns ids, metadata, and generated extraction context when available. Prefer available extraction text for answering about attachment contents; call getAttachmentUrl only when the raw file is explicitly needed or the extraction is unavailable/insufficient.",
      inputSchema: z.object({}),
      execute: async () => {
        const rows = await repo.listByThread(deps.threadId);
        // Only surface committed attachments — pending rows are orphans not yet referenced.
        const committed = rows.filter((r) => r.status === "committed");
        return JSON.stringify(
          committed.map((r) => ({
            id: r.id,
            filename: r.filename,
            mimeType: r.mimeType,
            width: r.width,
            height: r.height,
            extraction: attachmentExtractionForTool(r),
          })),
        );
      },
    }),
    getAttachmentUrl: tool({
      description:
        "Get a temporary signed URL for the raw file of an attachment in this conversation. Use this only when listAttachments has no sufficient generated extraction context, or when the user explicitly needs the original file. The URL expires; fetch a fresh one when needed.",
      inputSchema: z.object({
        attachmentId: z.string().describe("Attachment id from listAttachments"),
      }),
      execute: async ({ attachmentId }) => {
        const row = await repo.getByIdInThread(attachmentId, deps.threadId);
        if (!row) return `error: attachment ${attachmentId} not found in this conversation`;
        return await presignGet(presignDepsFromEnv(deps.env), row.r2Key, {
          anchorMs: bucketedAnchorMs(Date.now(), PRESIGN_WINDOW_MS),
          expiresInSeconds: PRESIGN_EXPIRES_SECONDS,
        });
      },
    }),
  };
}
