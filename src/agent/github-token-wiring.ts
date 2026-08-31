import type { DrizzleD1Database } from "drizzle-orm/d1";
import type * as schema from "../db/schema";
import { GithubInstallationRepository } from "../db/repositories/github-installations";
import { GithubAppClient } from "../github/app-client";
import type { GithubAppConfig } from "../github/config";
import { parseGithubRepoRef } from "../github/repo-url";
import { resolveGithubToken, type SessionRepo } from "../github/token-resolver";

export interface ApplyGithubTokenInput {
  db: DrizzleD1Database<typeof schema>;
  workspaceId: string;
  config: GithubAppConfig;
  existingEnv: Record<string, string>;
  repoUrls: string[];
  clientFactory?: (config: GithubAppConfig) => GithubAppClient;
  log?: (message: string) => void;
}

/**
 * Populates `GH_TOKEN` from a GitHub App installation covering the thread's
 * repos, unless a manual token is already set. Short-circuits (returns
 * `existingEnv` unchanged) when a manual token is present, there are no
 * GitHub repo URLs, or the workspace has no installations — keeping the
 * common "no App configured" / "no GitHub repos" path cheap.
 */
export async function applyGithubToken(
  input: ApplyGithubTokenInput,
): Promise<Record<string, string>> {
  if (input.existingEnv.GH_TOKEN) return input.existingEnv;
  const repos: SessionRepo[] = [];
  for (const url of input.repoUrls) {
    const ref = parseGithubRepoRef(url);
    if (ref) repos.push(ref);
  }
  if (repos.length === 0) return input.existingEnv;

  const installRepo = new GithubInstallationRepository(input.db);
  const installations = await installRepo.listForWorkspace(input.workspaceId);
  if (installations.length === 0) return input.existingEnv;

  const client = input.clientFactory
    ? input.clientFactory(input.config)
    : new GithubAppClient({ config: input.config });

  return resolveGithubToken({
    client,
    installations,
    repos,
    existingEnv: input.existingEnv,
    ...(input.log ? { log: input.log } : {}),
    onInstallationGone: async (installationId) => {
      await installRepo.markStatus(input.workspaceId, installationId, "disconnected");
      // TODO: reconcile access_status on agent_repositories referencing this installation (deferred)
    },
  });
}
