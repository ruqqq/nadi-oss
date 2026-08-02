import { appFetch } from "./lib/app-fetch";
import { errorFromResponse } from "./lib/http-error";

type FetchLike = typeof fetch;
const JSON_HEADERS = { "Content-Type": "application/json" } as const;

export interface WorkbenchRepository {
  id: string;
  workbenchId: string;
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

export type WorkbenchResourceProfile = "small" | "medium";

export interface WorkbenchSummary {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  setupScript: string;
  resourceProfile: WorkbenchResourceProfile;
  repositories: WorkbenchRepository[];
  envVars: Record<string, string>;
  secretEnvNames: string[];
  /** Additional host-allowlist domains, additive on top of the workspace list. */
  networkDomainAllowlist: string;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type WorkbenchStatus = "active" | "archived" | "all";

export type CreateWorkbenchInput = {
  name: string;
  description?: string;
  setupScript?: string;
  resourceProfile?: WorkbenchResourceProfile;
  networkDomainAllowlist?: string;
};

export type UpdateWorkbenchInput = Partial<CreateWorkbenchInput>;

/** Full repo entry accepted by `PUT /api/workbenches/:id/repositories`. */
export type WorkbenchRepositoryInput = {
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

export async function listWorkbenches(
  status?: WorkbenchStatus,
  fetchImpl: FetchLike = appFetch,
): Promise<WorkbenchSummary[]> {
  const query = status && status !== "active" ? `?status=${encodeURIComponent(status)}` : "";
  const res = await fetchImpl(`/api/workbenches${query}`, { credentials: "include" });
  if (!res.ok) throw await errorFromResponse(res, "load workbenches");
  const body = (await res.json()) as { workbenches: WorkbenchSummary[] };
  return body.workbenches;
}

export async function createWorkbench(
  input: CreateWorkbenchInput,
  fetchImpl: FetchLike = appFetch,
): Promise<WorkbenchSummary> {
  const res = await fetchImpl("/api/workbenches", {
    method: "POST",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await errorFromResponse(res, "create the workbench");
  const body = (await res.json()) as { workbench: WorkbenchSummary };
  return body.workbench;
}

export async function updateWorkbench(
  workbenchId: string,
  patch: UpdateWorkbenchInput,
  fetchImpl: FetchLike = appFetch,
): Promise<WorkbenchSummary> {
  const res = await fetchImpl(`/api/workbenches/${encodeURIComponent(workbenchId)}`, {
    method: "PATCH",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw await errorFromResponse(res, "save the workbench");
  const body = (await res.json()) as { workbench: WorkbenchSummary };
  return body.workbench;
}

export async function archiveWorkbench(
  workbenchId: string,
  fetchImpl: FetchLike = appFetch,
): Promise<WorkbenchSummary> {
  const res = await fetchImpl(`/api/workbenches/${encodeURIComponent(workbenchId)}/archive`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw await errorFromResponse(res, "archive the workbench");
  const body = (await res.json()) as { workbench: WorkbenchSummary };
  return body.workbench;
}

export async function setWorkbenchRepositories(
  workbenchId: string,
  repositories: WorkbenchRepositoryInput[],
  fetchImpl: FetchLike = appFetch,
): Promise<WorkbenchSummary> {
  const res = await fetchImpl(
    `/api/workbenches/${encodeURIComponent(workbenchId)}/repositories`,
    {
      method: "PUT",
      credentials: "include",
      headers: JSON_HEADERS,
      body: JSON.stringify(repositories),
    },
  );
  if (!res.ok) throw await errorFromResponse(res, "update the workbench's repositories");
  const body = (await res.json()) as { workbench: WorkbenchSummary };
  return body.workbench;
}

export async function setWorkbenchEnvVars(
  workbenchId: string,
  envVars: Record<string, string>,
  fetchImpl: FetchLike = appFetch,
): Promise<WorkbenchSummary> {
  const res = await fetchImpl(`/api/workbenches/${encodeURIComponent(workbenchId)}/env-vars`, {
    method: "PUT",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify({ envVars }),
  });
  if (!res.ok) throw await errorFromResponse(res, "update the workbench's env vars");
  const body = (await res.json()) as { workbench: WorkbenchSummary };
  return body.workbench;
}

export async function setWorkbenchSecret(
  workbenchId: string,
  name: string,
  value: string,
  fetchImpl: FetchLike = appFetch,
): Promise<void> {
  const res = await fetchImpl(
    `/api/workbenches/${encodeURIComponent(workbenchId)}/secrets/${encodeURIComponent(name)}`,
    {
      method: "PUT",
      credentials: "include",
      headers: JSON_HEADERS,
      body: JSON.stringify({ value }),
    },
  );
  if (!res.ok) throw await errorFromResponse(res, "save the workbench secret");
}

export async function deleteWorkbenchSecret(
  workbenchId: string,
  name: string,
  fetchImpl: FetchLike = appFetch,
): Promise<void> {
  const res = await fetchImpl(
    `/api/workbenches/${encodeURIComponent(workbenchId)}/secrets/${encodeURIComponent(name)}`,
    {
      method: "DELETE",
      credentials: "include",
    },
  );
  if (!res.ok) throw await errorFromResponse(res, "delete the workbench secret");
}
