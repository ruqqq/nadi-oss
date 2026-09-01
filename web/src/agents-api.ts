import { appFetch } from "./lib/app-fetch";
import { errorFromResponse } from "./lib/http-error";

type FetchLike = typeof fetch;
const JSON_HEADERS = { "Content-Type": "application/json" } as const;

export interface AgentRepository {
  id: string;
  agentId: string;
  source: "github" | "url";
  name: string;
  url: string;
  githubRepoId: number | null;
  sourceInstallationId: string | null;
  accessStatus: string;
  checkoutPathName: string;
  defaultBranch: string;
  rootDirectory: string;
  setupCommand: string;
  packageManager: string;
  createdAt: number;
}

export type AgentResourceProfile = "small" | "medium";

export interface AgentSummary {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  /** What the agent is told to be. Editable on the agent's own page. */
  systemPrompt: string;
  provider: string;
  model: string;
  modelInputModalities: string;
  reasoningEffort: string;
  /** null means UNKNOWN, not "cannot reason" — see the column's own note. */
  modelSupportsReasoning: boolean | null;
  /**
   * Kept, hibernating. `false` refuses new turns; the machine and its files
   * survive. Distinct from `archivedAt`, which is the delete.
   */
  enabled: boolean;
  setupScript: string;
  resourceProfile: AgentResourceProfile;
  repositories: AgentRepository[];
  envVars: Record<string, string>;
  secretEnvNames: string[];
  /** Additional host-allowlist domains, additive on top of the workspace list. */
  networkDomainAllowlist: string;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * The lean shape `GET /api/bootstrap` returns for its agent list — id/name/
 * description/enabled, nothing repositories/env-vars/secrets-shaped. Kept in
 * lockstep with the server's `AgentListItem`
 * (`src/http/agent-routes.ts:toAgentListItem`) by a wire-shape test
 * (`test/integration/bootstrap-routes.integration.test.ts`) rather than a
 * shared import — `web/` does not build against the Worker source (see
 * `bootstrap-api.ts`'s own note on this).
 */
export interface AgentListItem {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
}

/**
 * The agents a picker may OFFER: the enabled ones, plus whichever is already
 * selected so a control never blanks out or silently resets when its current
 * agent is disabled.
 *
 * A disabled agent is not a valid destination for work — routing a thread onto
 * one gives it no `exec_*` tools and says nothing — and the server refuses it
 * (`assertUsableAgentInWorkspace`). This is the one definition of that rule on
 * the client, so the pickers and the project default cannot disagree.
 *
 * NOT for the management surface: Settings lists disabled agents on purpose,
 * because turning one back on is the point.
 */
export function selectableAgents<T extends { id: string; enabled: boolean }>(
  agents: T[],
  keepSelectedId?: string | null,
): T[] {
  return agents.filter((agent) => agent.enabled || agent.id === keepSelectedId);
}

export type AgentStatus = "active" | "archived" | "all";

export type CreateAgentInput = {
  name: string;
  description?: string;
  setupScript?: string;
  resourceProfile?: AgentResourceProfile;
  networkDomainAllowlist?: string;
};

/**
 * Everything `PATCH /api/agents/:id` accepts. The behaviour half (instructions,
 * provider, model, reasoning) is validated server-side by the same parser the
 * workspace-default settings route uses, so the two surfaces cannot drift.
 */
export type UpdateAgentInput = Partial<CreateAgentInput> & {
  enabled?: boolean;
  systemPrompt?: string;
  provider?: string;
  model?: string;
  modelInputModalities?: string[];
  reasoningEffort?: string;
  modelSupportsReasoning?: boolean | null;
};

/** Full repo entry accepted by `PUT /api/agents/:id/repositories`. */
export type AgentRepositoryInput = {
  source: "github" | "url";
  name: string;
  url: string;
  githubRepoId?: number;
  sourceInstallationId?: string;
  checkoutPathName: string;
  defaultBranch?: string;
  rootDirectory?: string;
  setupCommand?: string;
  packageManager?: string;
};

export async function listAgents(
  status?: AgentStatus,
  fetchImpl: FetchLike = appFetch,
): Promise<AgentSummary[]> {
  const query = status && status !== "active" ? `?status=${encodeURIComponent(status)}` : "";
  const res = await fetchImpl(`/api/agents${query}`, { credentials: "include" });
  if (!res.ok) throw await errorFromResponse(res, "load agents");
  const body = (await res.json()) as { agents: AgentSummary[] };
  return body.agents;
}

/**
 * One agent by id. The new-chat picker needs it: an agent carries its OWN
 * provider, model and reasoning effort, and the bootstrap agent list is the
 * lean {@link AgentListItem} shape that deliberately does not.
 */
export async function getAgent(
  agentId: string,
  fetchImpl: FetchLike = appFetch,
): Promise<AgentSummary> {
  const res = await fetchImpl(`/api/agents/${encodeURIComponent(agentId)}`, {
    credentials: "include",
  });
  if (!res.ok) throw await errorFromResponse(res, "load the agent");
  const body = (await res.json()) as { agent: AgentSummary };
  return body.agent;
}

export async function createAgent(
  input: CreateAgentInput,
  fetchImpl: FetchLike = appFetch,
): Promise<AgentSummary> {
  const res = await fetchImpl("/api/agents", {
    method: "POST",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await errorFromResponse(res, "create the agent");
  const body = (await res.json()) as { agent: AgentSummary };
  return body.agent;
}

export async function updateAgent(
  agentId: string,
  patch: UpdateAgentInput,
  fetchImpl: FetchLike = appFetch,
): Promise<AgentSummary> {
  const res = await fetchImpl(`/api/agents/${encodeURIComponent(agentId)}`, {
    method: "PATCH",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw await errorFromResponse(res, "save the agent");
  const body = (await res.json()) as { agent: AgentSummary };
  return body.agent;
}

/**
 * Delete an agent. Soft server-side (`archived_at`), because `thread_index
 * .agent_id` is a NOT NULL foreign key and the agent's threads must stay
 * readable — but from the user's side this is the delete, and it is named that
 * way everywhere the user can see it.
 *
 * Refused with 409 when it is the workspace's last usable agent; the server's
 * message is shown verbatim.
 */
export async function deleteAgent(
  agentId: string,
  fetchImpl: FetchLike = appFetch,
): Promise<AgentSummary> {
  const res = await fetchImpl(`/api/agents/${encodeURIComponent(agentId)}/archive`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw await errorFromResponse(res, "delete the agent");
  const body = (await res.json()) as { agent: AgentSummary };
  return body.agent;
}

export async function setAgentRepositories(
  agentId: string,
  repositories: AgentRepositoryInput[],
  fetchImpl: FetchLike = appFetch,
): Promise<AgentSummary> {
  const res = await fetchImpl(`/api/agents/${encodeURIComponent(agentId)}/repositories`, {
    method: "PUT",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify(repositories),
  });
  if (!res.ok) throw await errorFromResponse(res, "update the agent's repositories");
  const body = (await res.json()) as { agent: AgentSummary };
  return body.agent;
}

export async function setAgentEnvVars(
  agentId: string,
  envVars: Record<string, string>,
  fetchImpl: FetchLike = appFetch,
): Promise<AgentSummary> {
  const res = await fetchImpl(`/api/agents/${encodeURIComponent(agentId)}/env-vars`, {
    method: "PUT",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify({ envVars }),
  });
  if (!res.ok) throw await errorFromResponse(res, "update the agent's env vars");
  const body = (await res.json()) as { agent: AgentSummary };
  return body.agent;
}

export async function setAgentSecret(
  agentId: string,
  name: string,
  value: string,
  fetchImpl: FetchLike = appFetch,
): Promise<void> {
  const res = await fetchImpl(
    `/api/agents/${encodeURIComponent(agentId)}/secrets/${encodeURIComponent(name)}`,
    {
      method: "PUT",
      credentials: "include",
      headers: JSON_HEADERS,
      body: JSON.stringify({ value }),
    },
  );
  if (!res.ok) throw await errorFromResponse(res, "save the agent secret");
}

export async function deleteAgentSecret(
  agentId: string,
  name: string,
  fetchImpl: FetchLike = appFetch,
): Promise<void> {
  const res = await fetchImpl(
    `/api/agents/${encodeURIComponent(agentId)}/secrets/${encodeURIComponent(name)}`,
    {
      method: "DELETE",
      credentials: "include",
    },
  );
  if (!res.ok) throw await errorFromResponse(res, "delete the agent secret");
}
