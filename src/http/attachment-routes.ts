import { and, eq } from "drizzle-orm";
import type { Env } from "../env";
import { validateRequestSession } from "../auth/session";
import { registryDb } from "../db/client";
import { threadIndex, workspaceMembers, attachments } from "../db/schema";
import { AttachmentRepository } from "../db/attachment-repository";
import { ThreadRepository } from "../db/repositories/threads";
import { assertFeedbackReporter } from "../feedback/access";
import {
  PRESIGN_EXPIRES_SECONDS,
  PRESIGN_WINDOW_MS,
  attachmentContentDisposition,
  bucketedAnchorMs,
  presignDepsFromEnv,
  presignGet,
} from "../storage/r2-presign";

export const ACCEPTED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
]);
/** Hard ceiling for a single chat attachment upload (client + server). */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** @deprecated Use MAX_ATTACHMENT_BYTES. Kept as an alias for existing imports. */
export const MAX_DERIVATIVE_BYTES = MAX_ATTACHMENT_BYTES;

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
};

// Binary document formats. Never served as markup, so the text/plain
// canonicalisation applied to html/svg is unnecessary. Extension is the source
// of truth when browsers report octet-stream / empty type.
//
// Formats Workers AI toMarkdown understands are also listed in
// DOCUMENT_MIME_TYPES (attachment-extraction.ts) for automatic extraction; the
// rest (notably epub) still upload and reach the agent via getAttachmentUrl.
export const BINARY_DOCUMENT_MIME_BY_EXT: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xls: "application/vnd.ms-excel",
  xlsm: "application/vnd.ms-excel.sheet.macroenabled.12",
  xlsb: "application/vnd.ms-excel.sheet.binary.macroenabled.12",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  numbers: "application/vnd.apple.numbers",
  epub: "application/epub+zip",
};

/** @deprecated Use BINARY_DOCUMENT_MIME_BY_EXT. */
export const OFFICE_MIME_BY_EXT = BINARY_DOCUMENT_MIME_BY_EXT;

const EXT_BY_BINARY_DOCUMENT_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(BINARY_DOCUMENT_MIME_BY_EXT).map(([ext, mime]) => [mime, ext]),
);

// Curated text/code allowlist keyed by lower-cased file extension. Browsers
// frequently report an empty or wrong File.type for these, so we accept and
// canonicalise by extension.
export const TEXT_MIME_BY_EXT: Record<string, string> = {
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
  xml: "application/xml",
  // Stored as text/plain (not text/html or image/svg+xml) so a presigned URL
  // can never serve executable HTML/SVG — defense-in-depth in case the bucket is
  // ever fronted by a cookie-sharing custom domain. MCP tools still read the raw
  // markup. (SVG is XML that can carry <script>, so it gets the same treatment.)
  html: "text/plain",
  htm: "text/plain",
  svg: "text/plain",
  css: "text/css",
  sql: "application/sql",
  js: "text/plain",
  jsx: "text/plain",
  ts: "text/plain",
  tsx: "text/plain",
  py: "text/plain",
  go: "text/plain",
  rs: "text/plain",
  java: "text/plain",
  c: "text/plain",
  h: "text/plain",
  cpp: "text/plain",
  hpp: "text/plain",
  sh: "text/plain",
  rb: "text/plain",
  php: "text/plain",
};

function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : "";
}

// Resolve an accepted upload to a canonical MIME + storage extension, or null
// if the file type is not allowed. Images/PDF trust the browser MIME; text/code
// are validated and canonicalised by extension.
function resolveUploadType(file: File): { mimeType: string; ext: string } | null {
  if (ACCEPTED_MIME_TYPES.has(file.type)) {
    return { mimeType: file.type, ext: EXT_BY_MIME[file.type]! };
  }
  const binaryExt = EXT_BY_BINARY_DOCUMENT_MIME[file.type];
  if (binaryExt) return { mimeType: file.type, ext: binaryExt };

  // Browsers report application/octet-stream (or "") for binary documents often
  // enough that the extension is the more reliable signal.
  const ext = fileExtension(file.name);
  if (!ext) return null;
  const binaryMime = BINARY_DOCUMENT_MIME_BY_EXT[ext];
  if (binaryMime) return { mimeType: binaryMime, ext };
  const mimeType = TEXT_MIME_BY_EXT[ext];
  return mimeType ? { mimeType, ext } : null;
}

const UPLOAD_RE = /^\/api\/threads\/([^/]+)\/attachments$/;
const SERVE_RE = /^\/api\/attachments\/([^/]+)$/;

export async function routeAttachments(req: Request, env: Env): Promise<Response | null> {
  const url = new URL(req.url);

  const uploadMatch = url.pathname.match(UPLOAD_RE);
  if (uploadMatch?.[1] && req.method === "POST") return handleUpload(req, env, uploadMatch[1]);

  const serveMatch = url.pathname.match(SERVE_RE);
  if (serveMatch?.[1] && req.method === "GET") return handleServe(req, env, serveMatch[1]);

  return null;
}

async function memberWorkspaceForThread(
  env: Env,
  threadId: string,
  userId: string,
): Promise<string | null> {
  const db = registryDb(env);
  const row = await db
    .select({ workspaceId: threadIndex.workspaceId })
    .from(threadIndex)
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, threadIndex.workspaceId),
        eq(workspaceMembers.userId, userId),
      ),
    )
    .where(eq(threadIndex.id, threadId))
    .get();
  return row?.workspaceId ?? null;
}

async function handleUpload(req: Request, env: Env, threadId: string): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const db = registryDb(env);
  const thread = await new ThreadRepository(db).getById(threadId);
  if (!thread) return new Response("Not found", { status: 404 });

  const workspaceId =
    thread.kind === "feedback"
      ? (await assertFeedbackReporter(env, threadId, session.user.id))?.workspaceId
      : await memberWorkspaceForThread(env, threadId, session.user.id);
  if (!workspaceId) return new Response("Not found", { status: 404 });

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return Response.json({ error: "missing_file" }, { status: 400 });
  const resolved = resolveUploadType(file);
  if (!resolved) {
    return Response.json({ error: "unsupported_file_type", mimeType: file.type }, { status: 415 });
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return Response.json({ error: "file_too_large", byteSize: file.size }, { status: 413 });
  }

  const id = crypto.randomUUID();
  const r2Key = `${workspaceId}/${threadId}/${id}.${resolved.ext}`;
  await env.ATTACHMENTS_BUCKET.put(r2Key, await file.arrayBuffer(), {
    httpMetadata: { contentType: resolved.mimeType },
  });

  const widthRaw = Number(form.get("width"));
  const heightRaw = Number(form.get("height"));
  const width = Number.isFinite(widthRaw) && widthRaw > 0 ? widthRaw : null;
  const height = Number.isFinite(heightRaw) && heightRaw > 0 ? heightRaw : null;

  await new AttachmentRepository(env.REGISTRY_DB).insert({
    id,
    workspaceId,
    threadId,
    mimeType: resolved.mimeType,
    filename: file.name,
    byteSize: file.size,
    width,
    height,
    r2Key,
    status: "pending",
    createdAt: Date.now(),
  });

  return Response.json(
    {
      id,
      url: `/api/attachments/${id}`,
      mimeType: resolved.mimeType,
      width,
      height,
      byteSize: file.size,
    },
    { status: 201 },
  );
}

async function handleServe(req: Request, env: Env, id: string): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const db = registryDb(env);
  const row = await db
    .select({
      r2Key: attachments.r2Key,
      filename: attachments.filename,
      threadId: attachments.threadId,
      kind: threadIndex.kind,
    })
    .from(attachments)
    .innerJoin(threadIndex, eq(threadIndex.id, attachments.threadId))
    .where(eq(attachments.id, id))
    .get();
  if (!row) return new Response("Not found", { status: 404 });
  if (row.kind === "feedback") {
    const scope = await assertFeedbackReporter(env, row.threadId, session.user.id);
    if (!scope) return new Response("Not found", { status: 404 });
  } else {
    const workspaceId = await memberWorkspaceForThread(env, row.threadId, session.user.id);
    if (!workspaceId) return new Response("Not found", { status: 404 });
  }

  const downloadParam = new URL(req.url).searchParams.get("download");
  const forceDownload = downloadParam === "1" || downloadParam === "true";

  const signed = await presignGet(presignDepsFromEnv(env), row.r2Key, {
    anchorMs: bucketedAnchorMs(Date.now(), PRESIGN_WINDOW_MS),
    expiresInSeconds: PRESIGN_EXPIRES_SECONDS,
    ...(forceDownload
      ? { responseContentDisposition: attachmentContentDisposition(row.filename) }
      : {}),
  });
  return new Response(null, { status: 302, headers: { location: signed } });
}
