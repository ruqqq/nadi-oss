import { http, HttpResponse } from "msw";
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
];
