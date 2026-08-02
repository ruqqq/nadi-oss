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

export async function listSkills(archived = false, fetchImpl: FetchLike = appFetch): Promise<Skill[]> {
  const path = archived ? "/api/skills?archived=1" : "/api/skills";
  const res = await fetchImpl(path, { credentials: "include" });
  if (!res.ok) throw await errorFromResponse(res, "list skills");
  return ((await res.json()) as { skills: Skill[] }).skills;
}

export async function setSkillEnabled(
  id: string,
  enabled: boolean,
  fetchImpl: FetchLike = appFetch,
): Promise<Skill> {
  const res = await fetchImpl(`/api/skills/${encodeURIComponent(id)}/enabled`, {
    method: "POST",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) throw await errorFromResponse(res, "update skill");
  return ((await res.json()) as { skill: Skill }).skill;
}

export async function archiveSkill(id: string, fetchImpl: FetchLike = appFetch): Promise<Skill> {
  const res = await fetchImpl(`/api/skills/${encodeURIComponent(id)}/archive`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw await errorFromResponse(res, "archive skill");
  return ((await res.json()) as { skill: Skill }).skill;
}

export async function restoreSkill(id: string, fetchImpl: FetchLike = appFetch): Promise<Skill> {
  const res = await fetchImpl(`/api/skills/${encodeURIComponent(id)}/restore`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw await errorFromResponse(res, "restore skill");
  return ((await res.json()) as { skill: Skill }).skill;
}
