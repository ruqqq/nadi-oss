import { appFetch } from "./lib/app-fetch";
import { errorFromResponse } from "./lib/http-error";
export interface Skill {
  id: string;
  name: string;
  description: string;
  body: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

type FetchLike = typeof fetch;
const JSON_HEADERS = { "Content-Type": "application/json" } as const;

/**
 * Which skills a call is about. Omitted (or null) means the workspace LIBRARY —
 * the shared skills every agent inherits, which is what the Skills settings tab
 * manages. An agent id means that one agent's private skills, which is what its
 * own page shows.
 */
export type SkillScope = string | null;

function scopeQuery(agentId: SkillScope, extra?: string): string {
  const params = new URLSearchParams(extra);
  if (agentId) params.set("agentId", agentId);
  const query = params.toString();
  return query ? `?${query}` : "";
}

export async function listSkills(
  archived = false,
  agentId: SkillScope = null,
  fetchImpl: FetchLike = appFetch,
): Promise<Skill[]> {
  const path = `/api/skills${scopeQuery(agentId, archived ? "archived=1" : "")}`;
  const res = await fetchImpl(path, { credentials: "include" });
  if (!res.ok) throw await errorFromResponse(res, "list skills");
  return ((await res.json()) as { skills: Skill[] }).skills;
}

export async function setSkillEnabled(
  id: string,
  enabled: boolean,
  agentId: SkillScope = null,
  fetchImpl: FetchLike = appFetch,
): Promise<Skill> {
  const res = await fetchImpl(`/api/skills/${encodeURIComponent(id)}/enabled${scopeQuery(agentId)}`, {
    method: "POST",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) throw await errorFromResponse(res, "update skill");
  return ((await res.json()) as { skill: Skill }).skill;
}

export async function archiveSkill(
  id: string,
  agentId: SkillScope = null,
  fetchImpl: FetchLike = appFetch,
): Promise<Skill> {
  const res = await fetchImpl(`/api/skills/${encodeURIComponent(id)}/archive${scopeQuery(agentId)}`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw await errorFromResponse(res, "archive skill");
  return ((await res.json()) as { skill: Skill }).skill;
}

export async function restoreSkill(
  id: string,
  agentId: SkillScope = null,
  fetchImpl: FetchLike = appFetch,
): Promise<Skill> {
  const res = await fetchImpl(`/api/skills/${encodeURIComponent(id)}/restore${scopeQuery(agentId)}`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw await errorFromResponse(res, "restore skill");
  return ((await res.json()) as { skill: Skill }).skill;
}
