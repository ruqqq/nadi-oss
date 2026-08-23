import { http, HttpResponse } from "msw";
import { ARTIFACT_TTL_MS } from "../chat/assistant-artifact-transcript";
import { getStore } from "../store";
import { errorResponse, notFound, pathParam } from "./util";

const VIEW_TTL_MS = 15 * 60 * 1000;

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

function artifactExpired(row: { status: string; expiresAt: number }, nowMs: number): boolean {
  return row.status === "expired" || nowMs >= row.expiresAt;
}

export const artifactHandlers = [
  http.get("*/api/threads/:threadId/artifacts", ({ params }) => {
    const threadId = pathParam(params, "threadId");
    const store = getStore();
    if (!store.threads.some((thread) => thread.threadId === threadId)) {
      return notFound("That chat");
    }
    const artifacts = Object.values(store.artifacts)
      .filter((artifact) => artifact.threadId === threadId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((artifact) => ({
        ...metadataPayload(artifact),
        createdAt: artifact.createdAt,
      }));
    const downloads = Object.values(store.attachments)
      .filter((attachment) => attachment.threadId === threadId && attachment.status === "committed")
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((attachment) => ({
        id: attachment.id,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        byteSize: attachment.byteSize,
        url: `/api/attachments/${attachment.id}`,
        createdAt: attachment.createdAt,
      }));
    return HttpResponse.json({ artifacts, downloads });
  }),
  http.get("/api/artifacts/:artifactId", ({ params }) => {
    const id = pathParam(params, "artifactId");
    const artifact = getStore().artifacts[id];
    if (!artifact) return notFound("That artifact");
    const nowMs = Date.now();
    if (artifactExpired(artifact, nowMs)) {
      artifact.status = "expired";
      return errorResponse(410, "This artifact has expired.");
    }
    return HttpResponse.json(metadataPayload(artifact));
  }),
  http.post("/api/artifacts/:artifactId/view", ({ params }) => {
    const id = pathParam(params, "artifactId");
    const artifact = getStore().artifacts[id];
    if (!artifact) return notFound("That artifact");
    const nowMs = Date.now();
    if (artifactExpired(artifact, nowMs)) {
      artifact.status = "expired";
      return errorResponse(410, "This artifact has expired.");
    }
    const expiresAt = nowMs + VIEW_TTL_MS;
    return HttpResponse.json({
      viewUrl: `https://artifacts.example/v/mock-token/${id}/`,
      expiresAt,
    });
  }),
  http.post("*/api/artifacts/:artifactId/republish", ({ params }) => {
    const id = pathParam(params, "artifactId");
    const artifact = getStore().artifacts[id];
    if (!artifact) return notFound("That artifact");
    if (artifact.filesGone) {
      return errorResponse(
        410,
        "This artifact's files are gone. Ask the assistant to publish it again.",
      );
    }
    artifact.status = "active";
    artifact.expiresAt = Date.now() + ARTIFACT_TTL_MS;
    return HttpResponse.json(metadataPayload(artifact));
  }),
];
