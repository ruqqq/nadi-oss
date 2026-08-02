import { appFetch } from "./lib/app-fetch";
import { errorFromResponse } from "./lib/http-error";
export type MemoryKind = "fact" | "preference" | "workflow" | "project";

export interface Memory {
  id: string;
  title: string | null;
  kind: MemoryKind;
  content: string;
  sourceThreadId: string | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

type FetchLike = typeof fetch;

export async function listMemories(
  archived = false,
  fetchImpl: FetchLike = appFetch,
): Promise<Memory[]> {
  const path = archived ? "/api/memories?archived=1" : "/api/memories";
  const res = await fetchImpl(path, { credentials: "include" });
  if (!res.ok) throw await errorFromResponse(res, "list memories");
  return ((await res.json()) as { memories: Memory[] }).memories;
}

export async function archiveMemory(id: string, fetchImpl: FetchLike = appFetch): Promise<Memory> {
  const res = await fetchImpl(`/api/memories/${encodeURIComponent(id)}/archive`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw await errorFromResponse(res, "archive memory");
  return ((await res.json()) as { memory: Memory }).memory;
}

export async function restoreMemory(id: string, fetchImpl: FetchLike = appFetch): Promise<Memory> {
  const res = await fetchImpl(`/api/memories/${encodeURIComponent(id)}/restore`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw await errorFromResponse(res, "restore memory");
  return ((await res.json()) as { memory: Memory }).memory;
}
