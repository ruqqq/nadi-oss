import { appFetch } from "./lib/app-fetch";
import { errorFromResponse } from "./lib/http-error";

type FetchLike = typeof fetch;
const JSON_HEADERS = { "Content-Type": "application/json" } as const;

export interface ProjectSummary {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  customInstructions: string;
  defaultAgentId: string | null;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type ProjectDetails = ProjectSummary;

export type ProjectStatus = "active" | "archived" | "all";

export type CreateProjectInput = {
  name: string;
  description?: string;
  customInstructions?: string;
};

export type UpdateProjectInput = Partial<CreateProjectInput> & {
  defaultAgentId?: string | null;
};

export async function listProjects(
  status: ProjectStatus = "active",
  fetchImpl: FetchLike = appFetch,
): Promise<ProjectSummary[]> {
  const query = status === "active" ? "" : `?status=${encodeURIComponent(status)}`;
  const res = await fetchImpl(`/api/projects${query}`, { credentials: "include" });
  if (!res.ok) throw await errorFromResponse(res, "load projects");
  const body = (await res.json()) as { projects: ProjectSummary[] };
  return body.projects;
}

export async function createProject(
  input: CreateProjectInput,
  fetchImpl: FetchLike = appFetch,
): Promise<ProjectSummary> {
  const res = await fetchImpl("/api/projects", {
    method: "POST",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await errorFromResponse(res, "create the project");
  const body = (await res.json()) as { project: ProjectSummary };
  return body.project;
}

export async function getProject(
  projectId: string,
  fetchImpl: FetchLike = appFetch,
): Promise<ProjectDetails> {
  const res = await fetchImpl(`/api/projects/${encodeURIComponent(projectId)}`, {
    credentials: "include",
  });
  if (!res.ok) throw await errorFromResponse(res, "load the project");
  const body = (await res.json()) as { project: ProjectDetails };
  return body.project;
}

export async function updateProject(
  projectId: string,
  input: UpdateProjectInput,
  fetchImpl: FetchLike = appFetch,
): Promise<ProjectSummary> {
  const res = await fetchImpl(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: "PATCH",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await errorFromResponse(res, "save the project");
  const body = (await res.json()) as { project: ProjectSummary };
  return body.project;
}

export async function archiveProject(
  projectId: string,
  fetchImpl: FetchLike = appFetch,
): Promise<ProjectSummary> {
  const res = await fetchImpl(`/api/projects/${encodeURIComponent(projectId)}/archive`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw await errorFromResponse(res, "archive the project");
  const body = (await res.json()) as { project: ProjectSummary };
  return body.project;
}
