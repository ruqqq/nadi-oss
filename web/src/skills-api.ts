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
  /**
   * How many agents this skill is live on — one copy, one edit, N agents. The
   * server sends it on LIBRARY-scope listings only (`GET /api/skills` with no
   * `agentId`), so it is optional here: on an agent's own skills it would
   * always read 1, and an older server sends it nowhere.
   */
  liveOnAgentCount?: number;
}

/**
 * A workspace-library skill as it applies to ONE agent: the row itself, plus
 * why it is or is not live there. Distinct from the effective set the model
 * loads — an excluded skill is absent from that, so a view built on it would
 * have nothing to offer the toggle.
 */
export interface LibrarySkillForAgent extends Skill {
  /** This agent opted out of it. */
  excluded: boolean;
  /** The agent's own skill of the same name that hides this one, if any. */
  shadowedByOwnSkillId: string | null;
}

export interface AgentSkills {
  /** The shared workspace library, annotated for this agent. */
  library: LibrarySkillForAgent[];
  /** This agent's private skills. */
  own: Skill[];
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

/** The three fields a person writes. Everything else is the server's. */
export interface SkillDraft {
  name: string;
  description: string;
  body: string;
}

/**
 * Author a skill in whichever scope `agentId` names — omitted means the shared
 * workspace LIBRARY, which is what Settings → Skills manages.
 *
 * This and `updateSkill` are the only way a library skill can be written: the
 * chat tools scope every write to the calling thread's agent, so what a model
 * creates is always agent-private.
 */
export async function createSkill(
  draft: SkillDraft,
  agentId: SkillScope = null,
  fetchImpl: FetchLike = appFetch,
): Promise<Skill> {
  const res = await fetchImpl(`/api/skills${scopeQuery(agentId)}`, {
    method: "POST",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify(draft),
  });
  if (!res.ok) throw await errorFromResponse(res, "create the skill");
  return ((await res.json()) as { skill: Skill }).skill;
}

/** Edit one skill in place. Omitted fields are left alone. */
export async function updateSkill(
  id: string,
  patch: Partial<SkillDraft>,
  agentId: SkillScope = null,
  fetchImpl: FetchLike = appFetch,
): Promise<Skill> {
  const res = await fetchImpl(`/api/skills/${encodeURIComponent(id)}${scopeQuery(agentId)}`, {
    method: "PATCH",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw await errorFromResponse(res, "save the skill");
  return ((await res.json()) as { skill: Skill }).skill;
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

/**
 * Promote one agent's private skill into the shared workspace library.
 *
 * `agentId` is the scope the skill lives in TODAY and is required: without it
 * the server looks in the library, where a private skill is not.
 */
export async function moveSkillToLibrary(
  id: string,
  agentId: string,
  fetchImpl: FetchLike = appFetch,
): Promise<Skill> {
  const res = await fetchImpl(
    `/api/skills/${encodeURIComponent(id)}/move-to-library${scopeQuery(agentId)}`,
    { method: "POST", credentials: "include" },
  );
  if (!res.ok) throw await errorFromResponse(res, "move skill to the library");
  return ((await res.json()) as { skill: Skill }).skill;
}

/**
 * Copy a skill onto one agent as its own. `agentId` names the SOURCE scope
 * (omit for the library); `targetAgentId` is where the copy lands.
 */
export async function copySkillToAgent(
  id: string,
  targetAgentId: string,
  agentId: SkillScope = null,
  fetchImpl: FetchLike = appFetch,
): Promise<Skill> {
  const res = await fetchImpl(
    `/api/skills/${encodeURIComponent(id)}/copy-to-agent${scopeQuery(agentId)}`,
    {
      method: "POST",
      credentials: "include",
      headers: JSON_HEADERS,
      body: JSON.stringify({ agentId: targetAgentId }),
    },
  );
  if (!res.ok) throw await errorFromResponse(res, "copy skill to the agent");
  return ((await res.json()) as { skill: Skill }).skill;
}

/** The library (annotated for this agent) and the agent's own skills. */
export async function listAgentSkills(
  agentId: string,
  fetchImpl: FetchLike = appFetch,
): Promise<AgentSkills> {
  const res = await fetchImpl(`/api/agents/${encodeURIComponent(agentId)}/skills`, {
    credentials: "include",
  });
  if (!res.ok) throw await errorFromResponse(res, "list skills");
  return (await res.json()) as AgentSkills;
}

/** Opt one agent in or out of one library skill. Returns nothing (204). */
export async function setLibrarySkillExcluded(
  agentId: string,
  skillId: string,
  excluded: boolean,
  fetchImpl: FetchLike = appFetch,
): Promise<void> {
  const res = await fetchImpl(
    `/api/agents/${encodeURIComponent(agentId)}/skills/${encodeURIComponent(skillId)}/exclusion`,
    {
      method: "POST",
      credentials: "include",
      headers: JSON_HEADERS,
      body: JSON.stringify({ excluded }),
    },
  );
  if (!res.ok) throw await errorFromResponse(res, "update skill");
}
