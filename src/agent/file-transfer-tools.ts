import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { Env } from "../env";
import { registryBinding } from "../db/client";
import { AttachmentRepository, type AttachmentRow } from "../db/attachment-repository";
import { attachmentsBucket } from "../storage/bucket-binding";
import { assertSafeUrl, UrlGuardError } from "../web/url-guard";

export const MAX_SIGNED_UPLOAD_SOURCE_BYTES = 10 * 1024 * 1024;

const DENIED_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "expect",
  "range",
]);

const ALLOWED_HEADER_NAMES = new Set([
  "content-type",
  "content-disposition",
  "content-encoding",
  "cache-control",
]);

const inputSchema = z.object({
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("attachment"), attachmentId: z.string().min(1) }),
    z.object({ kind: z.literal("url"), url: z.string().min(1) }),
  ]),
  signedUploadUrl: z.string().min(1),
  method: z.enum(["PUT", "POST"]).optional(),
  contentType: z.string().min(1).optional(),
  expectedSizeBytes: z.number().int().nonnegative().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

export type UploadToSignedUrlInput = z.infer<typeof inputSchema>;

export type TransferResult =
  | {
      ok: true;
      source: {
        kind: "attachment" | "url";
        filename?: string;
        contentType?: string;
        byteSize: number;
      };
      upload: {
        method: "PUT" | "POST";
        destinationHost: string;
        status: number;
      };
    }
  | {
      ok: false;
      code: string;
      message: string;
      status?: number;
      destinationHost?: string;
    };
type TransferError = Extract<TransferResult, { ok: false }>;

export interface AttachmentRepositoryLike {
  getByIdInThread(id: string, threadId: string): Promise<AttachmentRow | null>;
}

export interface UploadToSignedUrlDeps {
  env: Pick<Env, "ATTACHMENTS_BUCKET" | "REGISTRY_DB" | "REGISTRY_DO">;
  threadId: string;
  fetchImpl?: typeof fetch;
  attachmentRepository?: AttachmentRepositoryLike;
}

interface ResolvedSource {
  kind: "attachment" | "url";
  filename?: string;
  contentType?: string;
  byteSize: number;
  bytes: ArrayBuffer;
}

export function createFileTransferTools(deps: {
  env: Env;
  threadId: string;
  fetchImpl?: typeof fetch;
  attachmentRepository?: AttachmentRepositoryLike;
}): ToolSet {
  return {
    upload_to_signed_url: {
      ...tool({
        description:
          "Upload bytes from a current-thread Nadi attachment or a guarded external URL to a caller-provided signed upload URL. This writes bytes to an external bearer URL and requires user approval; never pass secrets in headers.",
        inputSchema,
        execute: async (input) =>
          uploadToSignedUrl(input, {
            env: deps.env,
            threadId: deps.threadId,
            ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
            ...(deps.attachmentRepository
              ? { attachmentRepository: deps.attachmentRepository }
              : {}),
          }),
      }),
      needsApproval: true,
    },
  };
}

export async function uploadToSignedUrl(
  input: UploadToSignedUrlInput,
  deps: UploadToSignedUrlDeps,
): Promise<TransferResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const method = input.method ?? "PUT";

  const uploadUrl = safeUrl(input.signedUploadUrl);
  if (!uploadUrl.ok) {
    return error("unsafe_destination_url", uploadUrl.message);
  }

  const headersResult = buildUploadHeaders(input.headers ?? {}, input.contentType);
  if (!headersResult.ok) return headersResult;

  const source = await resolveSource(input, deps, fetchImpl);
  if (!source.ok) return source;

  if (input.expectedSizeBytes !== undefined && input.expectedSizeBytes !== source.source.byteSize) {
    return error(
      "source_size_mismatch",
      `expected ${input.expectedSizeBytes} bytes but source has ${source.source.byteSize} bytes`,
    );
  }

  const headers = new Headers(headersResult.headers);
  if (!headers.has("content-type") && source.source.contentType) {
    headers.set("content-type", source.source.contentType);
  }

  let response: Response;
  try {
    response = await fetchImpl(uploadUrl.url.toString(), {
      method,
      headers,
      body: source.source.bytes,
      redirect: "manual",
    });
  } catch (caught) {
    return error("signed_upload_failed", `upload request failed: ${messageOf(caught)}`, {
      destinationHost: uploadUrl.url.host,
    });
  }

  if (!response.ok) {
    return error("signed_upload_failed", await failedUploadMessage(response), {
      status: response.status,
      destinationHost: uploadUrl.url.host,
    });
  }

  return {
    ok: true,
    source: withoutBytes(source.source),
    upload: {
      method,
      destinationHost: uploadUrl.url.host,
      status: response.status,
    },
  };
}

async function resolveSource(
  input: UploadToSignedUrlInput,
  deps: UploadToSignedUrlDeps,
  fetchImpl: typeof fetch,
): Promise<{ ok: true; source: ResolvedSource } | TransferError> {
  if (input.source.kind === "attachment") {
    return resolveAttachmentSource(input.source.attachmentId, deps);
  }
  return resolveUrlSource(input.source.url, fetchImpl);
}

async function resolveAttachmentSource(
  attachmentId: string,
  deps: UploadToSignedUrlDeps,
): Promise<{ ok: true; source: ResolvedSource } | TransferError> {
  const repo =
    deps.attachmentRepository ?? new AttachmentRepository(registryBinding(deps.env as Env));
  const row = await repo.getByIdInThread(attachmentId, deps.threadId);
  if (!row || row.status !== "committed") {
    return error(
      "attachment_not_found",
      `attachment ${attachmentId} not found in this conversation`,
    );
  }
  if (row.byteSize > MAX_SIGNED_UPLOAD_SOURCE_BYTES) {
    return error(
      "source_too_large",
      `source is ${row.byteSize} bytes; max is ${MAX_SIGNED_UPLOAD_SOURCE_BYTES}`,
    );
  }

  const object = await attachmentsBucket(deps.env).get(row.r2Key);
  if (!object) {
    return error("attachment_bytes_missing", `attachment ${attachmentId} bytes are missing`);
  }

  const bytes = await object.arrayBuffer();
  if (bytes.byteLength > MAX_SIGNED_UPLOAD_SOURCE_BYTES) {
    return error(
      "source_too_large",
      `source is ${bytes.byteLength} bytes; max is ${MAX_SIGNED_UPLOAD_SOURCE_BYTES}`,
    );
  }

  return {
    ok: true,
    source: {
      kind: "attachment",
      ...(row.filename ? { filename: row.filename } : {}),
      contentType: row.mimeType,
      byteSize: bytes.byteLength,
      bytes,
    },
  };
}

async function resolveUrlSource(
  rawUrl: string,
  fetchImpl: typeof fetch,
): Promise<{ ok: true; source: ResolvedSource } | TransferError> {
  const sourceUrl = safeUrl(rawUrl);
  if (!sourceUrl.ok) return error("unsafe_source_url", sourceUrl.message);

  let response: Response;
  try {
    response = await fetchImpl(sourceUrl.url.toString(), { redirect: "manual" });
  } catch (caught) {
    return error("source_fetch_failed", `source fetch failed: ${messageOf(caught)}`);
  }

  if (response.status >= 300 && response.status < 400) {
    return error("source_fetch_failed", "source returned a redirect");
  }
  if (!response.ok) {
    return error("source_fetch_failed", `source returned HTTP ${response.status}`);
  }

  const length = numericHeader(response.headers.get("content-length"));
  if (length !== null && length > MAX_SIGNED_UPLOAD_SOURCE_BYTES) {
    return error(
      "source_too_large",
      `source is ${length} bytes; max is ${MAX_SIGNED_UPLOAD_SOURCE_BYTES}`,
    );
  }

  const bytesResult = await readCappedResponseBody(response);
  if (!bytesResult.ok) return bytesResult;
  const bytes = bytesResult.bytes;
  if (bytes.byteLength > MAX_SIGNED_UPLOAD_SOURCE_BYTES) {
    return error(
      "source_too_large",
      `source is ${bytes.byteLength} bytes; max is ${MAX_SIGNED_UPLOAD_SOURCE_BYTES}`,
    );
  }

  return {
    ok: true,
    source: {
      kind: "url",
      ...(filenameFromHeadersOrUrl(response.headers, sourceUrl.url) ?? undefined),
      ...(response.headers.get("content-type")
        ? { contentType: response.headers.get("content-type")! }
        : {}),
      byteSize: bytes.byteLength,
      bytes,
    },
  };
}

function buildUploadHeaders(
  inputHeaders: Record<string, string>,
  contentType?: string,
): { ok: true; headers: Headers } | TransferError {
  const headers = new Headers();
  for (const [rawName, value] of Object.entries(inputHeaders)) {
    const name = rawName.trim().toLowerCase();
    if (!isAllowedHeaderName(name)) {
      return error("header_not_allowed", `header ${rawName} is not allowed`);
    }
    headers.set(name, value);
  }

  if (contentType && headers.has("content-type") && headers.get("content-type") !== contentType) {
    return error("content_type_conflict", "contentType and headers.content-type disagree");
  }
  if (contentType) headers.set("content-type", contentType);

  return { ok: true, headers };
}

function isAllowedHeaderName(name: string): boolean {
  if (DENIED_HEADER_NAMES.has(name)) return false;
  if (name.startsWith("x-amz-")) return false;
  return ALLOWED_HEADER_NAMES.has(name) || name.startsWith("metadata-");
}

function safeUrl(raw: string): { ok: true; url: URL } | { ok: false; message: string } {
  try {
    return { ok: true, url: assertSafeUrl(raw) };
  } catch (caught) {
    if (caught instanceof UrlGuardError) {
      return { ok: false, message: `unsafe url (${caught.reason})` };
    }
    return { ok: false, message: messageOf(caught) };
  }
}

async function readCappedResponseBody(
  response: Response,
): Promise<{ ok: true; bytes: ArrayBuffer } | TransferError> {
  if (!response.body) return { ok: true, bytes: new ArrayBuffer(0) };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_SIGNED_UPLOAD_SOURCE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return error(
          "source_too_large",
          `source exceeds max of ${MAX_SIGNED_UPLOAD_SOURCE_BYTES} bytes`,
        );
      }
      chunks.push(value);
    }
  } catch (caught) {
    return error("source_fetch_failed", `source read failed: ${messageOf(caught)}`);
  } finally {
    reader.releaseLock();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes: out.buffer };
}

function numericHeader(raw: string | null): number | null {
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function filenameFromHeadersOrUrl(headers: Headers, url: URL): { filename: string } | null {
  const disposition = headers.get("content-disposition");
  const match = disposition?.match(/filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i);
  const fromHeader = match?.[1] ?? match?.[2];
  if (fromHeader) return { filename: safeDecode(fromHeader) };

  const last = url.pathname.split("/").filter(Boolean).pop();
  return last ? { filename: safeDecode(last) } : null;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function withoutBytes(source: ResolvedSource): Omit<ResolvedSource, "bytes"> {
  const { bytes: _bytes, ...rest } = source;
  return rest;
}

async function failedUploadMessage(response: Response): Promise<string> {
  let snippet = "";
  try {
    snippet = (await response.text()).slice(0, 200);
  } catch {
    snippet = "";
  }
  return snippet
    ? `signed upload returned HTTP ${response.status}: ${snippet}`
    : `signed upload returned HTTP ${response.status}`;
}

function error(
  code: string,
  message: string,
  extra: Pick<TransferError, "status" | "destinationHost"> = {},
): TransferError {
  return { ok: false, code, message, ...extra };
}

function messageOf(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}
