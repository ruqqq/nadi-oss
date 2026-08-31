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

export type AgentStatus = "active" | "archived" | "all";

export type CreateAgentInput = {
  name: string;
  description?: string;
  setupScript?: string;
  resourceProfile?: AgentResourceProfile;
  networkDomainAllowlist?: string;
};

export type UpdateAgentInput = Partial<CreateAgentInput>;

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

export async function archiveAgent(
  agentId: string,
  fetchImpl: FetchLike = appFetch,
): Promise<AgentSummary> {
  const res = await fetchImpl(`/api/agents/${encodeURIComponent(agentId)}/archive`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw await errorFromResponse(res, "archive the agent");
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
