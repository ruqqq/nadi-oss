import { and, eq } from "drizzle-orm";
import type { Env } from "../env";
import { artifactExpired, respondExpired, r2PrefixHasObjects } from "../artifacts/serve";
import { ARTIFACT_TTL_MS } from "../artifacts/ttl";
import { deriveArtifactViewSecret, signArtifactViewToken } from "../artifacts/view-token";
import { validateRequestSession } from "../auth/session";
import { registryBinding, registryDb } from "../db/client";
import { ArtifactRepository } from "../db/artifact-repository";
import { AttachmentRepository } from "../db/attachment-repository";
import { threadIndex, workspaceMembers } from "../db/schema";
import { assertFeedbackReporter } from "../feedback/access";
import { attachmentsBucket } from "../storage/bucket-binding";

export const VIEW_TTL_MS = 15 * 60 * 1000;
export const ARTIFACT_FILES_GONE =
  "This artifact's files are gone. Ask the assistant to publish it again.";

const METADATA_RE = /^\/api\/artifacts\/([^/]+)$/;
const VIEW_RE = /^\/api\/artifacts\/([^/]+)\/view$/;
const REPUBLISH_RE = /^\/api\/artifacts\/([^/]+)\/republish$/;
const THREAD_LIST_RE = /^\/api\/threads\/([^/]+)\/artifacts$/;

export function resolveArtifactOrigin(req: Request, artifactsHost: string): string {
  const url = new URL(req.url);
  const host = url.hostname.toLowerCase();
  const isLocalhostStyle =
    host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]";
  if (isLocalhostStyle) {
    const port = url.port;
    return port ? `http://${artifactsHost}:${port}` : `http://${artifactsHost}`;
  }
  return `https://${artifactsHost}`;
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

async function authorizeArtifactAccess(
  env: Env,
  threadId: string,
  userId: string,
): Promise<boolean> {
  const db = registryDb(env);
  const thread = await db
    .select({ kind: threadIndex.kind })
    .from(threadIndex)
    .where(eq(threadIndex.id, threadId))
    .get();
  if (!thread) return false;

  if (thread.kind === "feedback") {
    const scope = await assertFeedbackReporter(env, threadId, userId);
    return scope !== null;
  }

  const workspaceId = await memberWorkspaceForThread(env, threadId, userId);
  return workspaceId !== null;
}

function artifactPreviewHostNotConfigured(): Response {
  return new Response("Artifact preview host is not configured", { status: 503 });
}

function metadataPayload(row: {
  id: string;
  title: string;
  entryPath: string;
  fileCount: number;
  byteSize: number;
  expiresAt: number;
  status: string;
}) {
  return {
    id: row.id,
    title: row.title,
    entryPath: row.entryPath,
    fileCount: row.fileCount,
    byteSize: row.byteSize,
    expiresAt: row.expiresAt,
    status: row.status,
    url: `/api/artifacts/${row.id}`,
  };
}

async function loadAuthorizedArtifact(
  env: Env,
  id: string,
  userId: string,
): Promise<
  | { ok: true; row: NonNullable<Awaited<ReturnType<ArtifactRepository["getById"]>>> }
  | { ok: false; response: Response }
> {
  const repo = new ArtifactRepository(registryBinding(env));
  const row = await repo.getById(id);
  if (!row) return { ok: false, response: new Response("Not found", { status: 404 }) };

  const allowed = await authorizeArtifactAccess(env, row.threadId, userId);
  if (!allowed) return { ok: false, response: new Response("Not found", { status: 404 }) };

  const nowMs = Date.now();
  if (artifactExpired(row, nowMs)) {
    return { ok: false, response: await respondExpired(repo, id) };
  }

  return { ok: true, row };
}

async function handleMetadata(req: Request, env: Env, id: string): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const loaded = await loadAuthorizedArtifact(env, id, session.user.id);
  if (!loaded.ok) return loaded.response;

  return Response.json(metadataPayload(loaded.row));
}

async function handleViewMint(req: Request, env: Env, id: string): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const artifactsHost = (env.ARTIFACTS_HOST ?? "").trim();
  if (!artifactsHost) return artifactPreviewHostNotConfigured();

  const loaded = await loadAuthorizedArtifact(env, id, session.user.id);
  if (!loaded.ok) return loaded.response;

  const exp = Date.now() + VIEW_TTL_MS;
  const secret = await deriveArtifactViewSecret(env.BETTER_AUTH_SECRET);
  const token = await signArtifactViewToken(secret, { artifactId: id, exp });
  const artifactOrigin = resolveArtifactOrigin(req, artifactsHost);
  const viewUrl = `${artifactOrigin}/v/${token}/${id}/`;

  return Response.json({ viewUrl, expiresAt: exp });
}

async function handleRepublish(req: Request, env: Env, id: string): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const repo = new ArtifactRepository(registryBinding(env));
  const row = await repo.getById(id);
  if (!row) return new Response("Not found", { status: 404 });

  const allowed = await authorizeArtifactAccess(env, row.threadId, session.user.id);
  if (!allowed) return new Response("Not found", { status: 404 });

  const hasFiles = await r2PrefixHasObjects(attachmentsBucket(env), row.r2Prefix);
  if (!hasFiles) return new Response(ARTIFACT_FILES_GONE, { status: 410 });

  const expiresAt = Date.now() + ARTIFACT_TTL_MS;
  await repo.reactivate(id, expiresAt);
  return Response.json(metadataPayload({ ...row, status: "active", expiresAt }));
}

async function handleThreadList(req: Request, env: Env, threadId: string): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const allowed = await authorizeArtifactAccess(env, threadId, session.user.id);
  if (!allowed) return new Response("Not found", { status: 404 });

  const binding = registryBinding(env);
  const [artifactRows, attachmentRows] = await Promise.all([
    new ArtifactRepository(binding).listByThread(threadId),
    new AttachmentRepository(binding).listByThread(threadId),
  ]);

  const artifacts = artifactRows.map((row) => ({
    ...metadataPayload(row),
    createdAt: row.createdAt,
  }));
  const downloads = attachmentRows
    .filter((row) => row.status === "committed")
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((row) => ({
      id: row.id,
      filename: row.filename,
      mimeType: row.mimeType,
      byteSize: row.byteSize,
      url: `/api/attachments/${row.id}`,
      createdAt: row.createdAt,
    }));

  return Response.json({ artifacts, downloads });
}

export async function routeArtifacts(req: Request, env: Env): Promise<Response | null> {
  const url = new URL(req.url);

  const threadListMatch = url.pathname.match(THREAD_LIST_RE);
  if (threadListMatch?.[1] && req.method === "GET") {
    return handleThreadList(req, env, decodeURIComponent(threadListMatch[1]));
  }

  const metadataMatch = url.pathname.match(METADATA_RE);
  if (metadataMatch?.[1] && req.method === "GET") {
    return handleMetadata(req, env, metadataMatch[1]);
  }

  const viewMatch = url.pathname.match(VIEW_RE);
  if (viewMatch?.[1] && req.method === "POST") {
    return handleViewMint(req, env, viewMatch[1]);
  }

  const republishMatch = url.pathname.match(REPUBLISH_RE);
  if (republishMatch?.[1] && req.method === "POST") {
    return handleRepublish(req, env, republishMatch[1]);
  }

  return null;
}
