import type { Env } from "../env";
import { ArtifactRepository } from "../db/artifact-repository";
import { mimeFromFilename } from "./mime";
import { normalizeArtifactRelPath } from "./paths";
import { deriveArtifactViewSecret, verifyArtifactViewToken } from "./view-token";

const ARTIFACT_PATH = /^\/v\/([^/]+)\/(art_[^/]+)(?:\/(.*))?$/;

/** Best-effort delete of every object under `prefix`. Used by serve expiry and publish rollback. */
export async function deleteR2PrefixBestEffort(bucket: R2Bucket, prefix: string): Promise<void> {
  try {
    let cursor: string | undefined;
    for (;;) {
      const listOptions: R2ListOptions = cursor ? { prefix, cursor } : { prefix };
      const page = await bucket.list(listOptions);
      await Promise.all(page.objects.map((obj) => bucket.delete(obj.key).catch(() => undefined)));
      if (!page.truncated) break;
      cursor = page.cursor;
    }
  } catch {
    // best-effort cleanup
  }
}

export function artifactExpired(
  row: { status: string; expiresAt: number },
  nowMs: number,
): boolean {
  return row.status === "expired" || row.expiresAt < nowMs;
}

export async function respondExpired(
  env: Env,
  repo: ArtifactRepository,
  artifactId: string,
  r2Prefix: string | undefined,
): Promise<Response> {
  try {
    await repo.markExpired(artifactId);
  } catch {
    // best-effort
  }
  if (r2Prefix) {
    await deleteR2PrefixBestEffort(env.ATTACHMENTS_BUCKET, r2Prefix);
  }
  return new Response("Artifact expired", { status: 410 });
}

/** Serve artifact files on the isolated ARTIFACTS_HOST origin. */
export async function handleArtifactHostRequest(req: Request, env: Env): Promise<Response> {
  if (req.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  const url = new URL(req.url);
  const match = url.pathname.match(ARTIFACT_PATH);
  if (!match) {
    return new Response("Not found", { status: 404 });
  }

  const [, tokenRaw, artifactId, rest] = match;
  const token = tokenRaw!;
  const secret = await deriveArtifactViewSecret(env.BETTER_AUTH_SECRET);
  const nowMs = Date.now();
  const payload = await verifyArtifactViewToken(secret, token, nowMs);
  if (!payload || payload.artifactId !== artifactId) {
    return new Response("Unauthorized", { status: 401 });
  }

  const repo = new ArtifactRepository(env.REGISTRY_DB);
  const row = await repo.getById(artifactId);
  if (!row || artifactExpired(row, nowMs)) {
    return respondExpired(env, repo, artifactId, row?.r2Prefix);
  }

  let rel: string;
  if (rest === undefined || rest === "") {
    rel = row.entryPath;
  } else {
    const normalized = normalizeArtifactRelPath(rest);
    if (normalized === null) {
      return new Response("Not found", { status: 404 });
    }
    rel = normalized;
  }

  const key = `${row.r2Prefix}${rel}`;
  const object = await env.ATTACHMENTS_BUCKET.get(key);
  if (!object) {
    return new Response("Not found", { status: 404 });
  }

  const mime = object.httpMetadata?.contentType?.split(";")[0]?.trim() ?? mimeFromFilename(rel);
  const headers = new Headers({
    "content-type": mime,
    "x-content-type-options": "nosniff",
    "cache-control": "private, max-age=300",
  });
  if (mime === "application/octet-stream") {
    const filename = rel.split("/").pop() ?? "download";
    headers.set("content-disposition", `attachment; filename="${filename}"`);
  }

  return new Response(object.body, { headers });
}
