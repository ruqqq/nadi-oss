import { appFetch } from "./lib/app-fetch";
import { errorFromResponse } from "./lib/http-error";

type FetchLike = typeof fetch;
const JSON_HEADERS = { "Content-Type": "application/json" } as const;

export const GITHUB_CONNECT_PATH = "/api/settings/github/connect";

export interface GithubInstallation {
  id: string;
  installationId: number;
  accountLogin: string;
  accountType: "org" | "user";
  repositorySelection: "all" | "selected";
  status: "active" | "disconnected" | "suspended";
  connectedByUserId: string;
  updatedAt: number;
}

export interface GithubSettings {
  configured: boolean;
  installations: GithubInstallation[];
}

export async function getGithubSettings(fetchImpl: FetchLike = appFetch): Promise<GithubSettings> {
  const res = await fetchImpl("/api/settings/github", { credentials: "include" });
  if (!res.ok) throw await errorFromResponse(res, "load GitHub settings");
  return (await res.json()) as GithubSettings;
}

export interface GithubRepo {
  id: number;
  fullName: string;
  owner: string;
  name: string;
  defaultBranch: string;
  cloneUrl: string;
  private: boolean;
}

export async function listInstallationRepositories(
  installationId: string,
  page?: number,
  fetchImpl: FetchLike = appFetch,
): Promise<{ repositories: GithubRepo[]; hasNextPage: boolean }> {
  const query = page !== undefined ? `?page=${encodeURIComponent(String(page))}` : "";
  const res = await fetchImpl(
    `/api/settings/github/installations/${encodeURIComponent(installationId)}/repositories${query}`,
    { credentials: "include" },
  );
  if (!res.ok) throw await errorFromResponse(res, "load the installation's repositories");
  return (await res.json()) as { repositories: GithubRepo[]; hasNextPage: boolean };
}

export async function disconnectGithubInstallation(
  installationId: number,
  fetchImpl: FetchLike = appFetch,
): Promise<void> {
  const res = await fetchImpl("/api/settings/github/disconnect", {
    method: "POST",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify({ installationId }),
  });
  if (!res.ok) throw await errorFromResponse(res, "disconnect the GitHub installation");
}
