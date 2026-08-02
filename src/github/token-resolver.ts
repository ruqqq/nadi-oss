import { GithubAppClient, GithubInstallationGoneError } from "./app-client";
import type { GithubAppInstallationRow } from "../db/schema";

export interface SessionRepo {
  owner: string;
  repo: string;
}

export interface ResolveGithubTokenInput {
  client: GithubAppClient;
  installations: GithubAppInstallationRow[];
  repos: SessionRepo[];
  existingEnv: Record<string, string>;
  onInstallationGone?: (installationId: number) => Promise<void>;
  log?: (message: string) => void;
}

/** Clone and push only — what every installation has been granted since v1. */
const BASE_PERMISSIONS = { contents: "write", metadata: "read" } as const;

/**
 * Adds what the agent needs to open a PR and read its own CI result.
 * `workflows` is required separately from `contents` to push a commit touching
 * `.github/workflows/*`. Deliberately no `actions: write` — triggering runs is
 * the CI/deploy follow-up.
 */
const PERMISSIONS = {
  ...BASE_PERMISSIONS,
  pull_requests: "write",
  workflows: "write",
  checks: "read",
  statuses: "read",
  actions: "read",
} as const;

export async function resolveGithubToken(
  input: ResolveGithubTokenInput,
): Promise<Record<string, string>> {
  const { client, installations, repos, existingEnv, onInstallationGone, log } = input;

  if (existingEnv.GH_TOKEN) return existingEnv; // manual token always wins
  if (repos.length === 0 || installations.length === 0) return existingEnv;

  const active = installations.filter((i) => i.status === "active");
  const byOwner = new Map<string, GithubAppInstallationRow>();
  for (const inst of active) byOwner.set(inst.accountLogin.toLowerCase(), inst);

  // Group covered repos by installation.
  const reposByInstallation = new Map<
    number,
    { inst: GithubAppInstallationRow; repos: string[] }
  >();
  const uncovered: SessionRepo[] = [];
  for (const r of repos) {
    const inst = byOwner.get(r.owner.toLowerCase());
    if (!inst) {
      uncovered.push(r);
      continue;
    }
    const entry = reposByInstallation.get(inst.installationId) ?? { inst, repos: [] };
    entry.repos.push(r.repo);
    reposByInstallation.set(inst.installationId, entry);
  }

  if (reposByInstallation.size === 0) {
    log?.(
      `GitHub: no connected installation covers ${uncovered
        .map((r) => `${r.owner}/${r.repo}`)
        .join(", ")}; cloning will need a manual GH_TOKEN.`,
    );
    return existingEnv;
  }

  // v1: mint for the single installation covering the most repos.
  const sorted = [...reposByInstallation.values()].sort((a, b) => b.repos.length - a.repos.length);
  const chosen = sorted[0];
  if (!chosen) return existingEnv; // unreachable: reposByInstallation.size > 0 above
  const others = sorted.slice(1);
  if (others.length > 0 || uncovered.length > 0) {
    const skipped = [
      ...others.flatMap((e) => e.repos.map((n) => `${e.inst.accountLogin}/${n}`)),
      ...uncovered.map((r) => `${r.owner}/${r.repo}`),
    ];
    log?.(
      `GitHub: v1 mints one installation per session; injecting token for ${chosen.inst.accountLogin}. ` +
        `Not covered this session: ${skipped.join(", ")} (see credential-helper follow-up).`,
    );
  }

  try {
    const token = await mintWithFallback(client, chosen.inst.installationId, chosen.repos, log);
    return { ...existingEnv, GH_TOKEN: token };
  } catch (err) {
    if (err instanceof GithubInstallationGoneError) {
      log?.(`GitHub: installation ${chosen.inst.installationId} is gone; marking disconnected.`);
      await onInstallationGone?.(chosen.inst.installationId);
      return existingEnv;
    }
    log?.(`GitHub: failed to mint installation token: ${(err as Error).message}`);
    return existingEnv;
  }
}

/**
 * Mints the wide set, falling back once to clone-only access.
 *
 * Keyed on FAILURE, never on a status code. GitHub documents 422 for a
 * permission outside the installation's grant, but `mintInstallationToken`
 * maps 403 to `GithubInstallationGoneError`, and the caller answers that by
 * marking the installation `disconnected` in D1. Guessing wrong would
 * disconnect healthy installations en masse, so the wide attempt's error is
 * swallowed unconditionally and only the narrow attempt's error escapes.
 */
async function mintWithFallback(
  client: GithubAppClient,
  installationId: number,
  repositories: string[],
  log: ((message: string) => void) | undefined,
): Promise<string> {
  try {
    const { token } = await client.mintInstallationToken(installationId, {
      repositories,
      permissions: { ...PERMISSIONS },
    });
    return token;
  } catch (err) {
    log?.(
      `GitHub: installation ${installationId} could not mint the full permission set ` +
        `(${(err as Error).message}); retrying with clone-only access. Opening pull requests ` +
        `will not work until the installation re-consents to the App's current permissions.`,
    );
  }
  // Outside the catch so a genuine revocation surfaces its own error, not a
  // confusing chain from the first attempt.
  const { token } = await client.mintInstallationToken(installationId, {
    repositories,
    permissions: { ...BASE_PERMISSIONS },
  });
  return token;
}
