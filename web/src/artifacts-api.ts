import { appFetch } from "./lib/app-fetch";
import { errorFromResponse } from "./lib/http-error";

type FetchLike = typeof fetch;

export type ThreadArtifactItem = {
  id: string;
  title: string;
  entryPath: string;
  fileCount: number;
  byteSize: number;
  expiresAt: number;
  status: string;
  url: string;
  createdAt: number;
};

export type ThreadDownloadItem = {
  id: string;
  filename: string | null;
  mimeType: string;
  byteSize: number;
  url: string;
  createdAt: number;
};

export type ThreadArtifactsResponse = {
  artifacts: ThreadArtifactItem[];
  downloads: ThreadDownloadItem[];
};

export async function listThreadArtifacts(
  threadId: string,
  fetchImpl: FetchLike = appFetch,
): Promise<ThreadArtifactsResponse> {
  const res = await fetchImpl(`/api/threads/${encodeURIComponent(threadId)}/artifacts`, {
    credentials: "include",
  });
  if (!res.ok) {
    throw await errorFromResponse(res, "load this chat's artifacts");
  }
  const body = (await res.json()) as Partial<ThreadArtifactsResponse>;
  return {
    artifacts: Array.isArray(body.artifacts) ? body.artifacts : [],
    downloads: Array.isArray(body.downloads) ? body.downloads : [],
  };
}
