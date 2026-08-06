import { and, eq } from "drizzle-orm";
import type { Env } from "../env";
import { artifactExpired, respondExpired } from "../artifacts/serve";
import { deriveArtifactViewSecret, signArtifactViewToken } from "../artifacts/view-token";
import { validateRequestSession } from "../auth/session";
import { registryBinding, registryDb } from "../db/client";
import { ArtifactRepository } from "../db/artifact-repository";
import { threadIndex, workspaceMembers } from "../db/schema";
import { assertFeedbackReporter } from "../feedback/access";

export const VIEW_TTL_MS = 15 * 60 * 1000;

const METADATA_RE = /^\/api\/artifacts\/([^/]+)$/;
const VIEW_RE = /^\/api\/artifacts\/([^/]+)\/view$/;

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
    return { ok: false, response: await respondExpired(env, repo, id, row.r2Prefix) };
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

export async function routeArtifacts(req: Request, env: Env): Promise<Response | null> {
  const url = new URL(req.url);

  const metadataMatch = url.pathname.match(METADATA_RE);
  if (metadataMatch?.[1] && req.method === "GET") {
    return handleMetadata(req, env, metadataMatch[1]);
  }

  const viewMatch = url.pathname.match(VIEW_RE);
  if (viewMatch?.[1] && req.method === "POST") {
    return handleViewMint(req, env, viewMatch[1]);
  }

  return null;
}
