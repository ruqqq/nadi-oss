import { appFetch } from "./lib/app-fetch";
import { errorFromResponse } from "./lib/http-error";
export type ToolPolicy = "auto_allow" | "approval_required" | "deny";

export interface McpServer {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  createdAt: number;
}

export interface McpToolView {
  name: string;
  description: string | null;
  policy: ToolPolicy;
}

type FetchLike = typeof fetch;
const JSON_HEADERS = { "Content-Type": "application/json" } as const;

export async function listMcpServers(fetchImpl: FetchLike = appFetch): Promise<McpServer[]> {
  const res = await fetchImpl("/api/mcp/servers", { credentials: "include" });
  if (!res.ok) throw await errorFromResponse(res, "list MCP servers");
  return ((await res.json()) as { servers: McpServer[] }).servers;
}

export async function createMcpServer(
  input: { name: string; url: string },
  fetchImpl: FetchLike = appFetch,
): Promise<McpServer> {
  const res = await fetchImpl("/api/mcp/servers", {
    method: "POST",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await errorFromResponse(res, "add MCP server");
  return ((await res.json()) as { server: McpServer }).server;
}

export async function updateMcpServer(
  id: string,
  patch: { name?: string; enabled?: boolean },
  fetchImpl: FetchLike = appFetch,
): Promise<McpServer> {
  const res = await fetchImpl(`/api/mcp/servers/${encodeURIComponent(id)}`, {
    method: "PATCH",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw await errorFromResponse(res, "update MCP server");
  return ((await res.json()) as { server: McpServer }).server;
}

export async function deleteMcpServer(id: string, fetchImpl: FetchLike = appFetch): Promise<void> {
  const res = await fetchImpl(`/api/mcp/servers/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) throw await errorFromResponse(res, "remove MCP server");
}

export async function listMcpServerTools(
  id: string,
  fetchImpl: FetchLike = appFetch,
): Promise<{ needsAuth: boolean; tools: McpToolView[] }> {
  const res = await fetchImpl(`/api/mcp/servers/${encodeURIComponent(id)}/tools`, {
    credentials: "include",
  });
  if (!res.ok) throw await errorFromResponse(res, "load tools");
  const body = (await res.json()) as { needsAuth?: boolean; tools?: McpToolView[] };
  return { needsAuth: body.needsAuth ?? false, tools: body.tools ?? [] };
}

export async function authorizeMcpServer(
  id: string,
  fetchImpl: FetchLike = appFetch,
): Promise<{ authUrl?: string; ready?: boolean }> {
  const res = await fetchImpl(`/api/mcp/servers/${encodeURIComponent(id)}/authorize`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw await errorFromResponse(res, "start authorization");
  return (await res.json()) as { authUrl?: string; ready?: boolean };
}

export async function setMcpServerPolicies(
  id: string,
  policies: { toolName: string; policy: ToolPolicy }[],
  fetchImpl: FetchLike = appFetch,
): Promise<{ toolName: string; policy: ToolPolicy }[]> {
  const res = await fetchImpl(`/api/mcp/servers/${encodeURIComponent(id)}/policies`, {
    method: "PUT",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify({ policies }),
  });
  if (!res.ok) throw await errorFromResponse(res, "save policies");
  return ((await res.json()) as { policies: { toolName: string; policy: ToolPolicy }[] }).policies;
}
