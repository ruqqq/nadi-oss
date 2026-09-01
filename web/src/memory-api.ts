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

/**
 * Memories belong to ONE agent. `agentId` names which — the agent's own page
 * passes it. Null falls back to the workspace's earliest agent, which is what
 * every pre-merge caller meant by "the agent".
 */
function scopeQuery(agentId: string | null, extra?: string): string {
  const params = new URLSearchParams(extra);
  if (agentId) params.set("agentId", agentId);
  const query = params.toString();
  return query ? `?${query}` : "";
}

export async function listMemories(
  archived = false,
  agentId: string | null = null,
  fetchImpl: FetchLike = appFetch,
): Promise<Memory[]> {
  const path = `/api/memories${scopeQuery(agentId, archived ? "archived=1" : "")}`;
  const res = await fetchImpl(path, { credentials: "include" });
  if (!res.ok) throw await errorFromResponse(res, "list memories");
  return ((await res.json()) as { memories: Memory[] }).memories;
}

export async function archiveMemory(
  id: string,
  agentId: string | null = null,
  fetchImpl: FetchLike = appFetch,
): Promise<Memory> {
  const res = await fetchImpl(
    `/api/memories/${encodeURIComponent(id)}/archive${scopeQuery(agentId)}`,
    { method: "POST", credentials: "include" },
  );
  if (!res.ok) throw await errorFromResponse(res, "archive memory");
  return ((await res.json()) as { memory: Memory }).memory;
}

export async function restoreMemory(
  id: string,
  agentId: string | null = null,
  fetchImpl: FetchLike = appFetch,
): Promise<Memory> {
  const res = await fetchImpl(
    `/api/memories/${encodeURIComponent(id)}/restore${scopeQuery(agentId)}`,
    { method: "POST", credentials: "include" },
  );
  if (!res.ok) throw await errorFromResponse(res, "restore memory");
  return ((await res.json()) as { memory: Memory }).memory;
}
