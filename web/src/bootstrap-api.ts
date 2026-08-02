import type { AuthSession } from "./auth-api";
import { appFetch } from "./lib/app-fetch";
import type { ProjectSummary } from "./projects-api";
import type { AgentSettingsResponse } from "./settings-api";
import type { ThreadSummary } from "./threads-api";

type FetchLike = typeof fetch;

type BootstrapPayload = {
  session?: {
    authenticated?: boolean;
    user?: { id: string; email?: string; name?: string | null };
  };
  settings?: AgentSettingsResponse | null;
  threads?: ThreadSummary[];
  threadsNextCursor?: string | null;
  projects?: ProjectSummary[];
  features?: {
    voiceInput?: boolean;
    workersAi?: boolean;
    feedbackAdmin?: boolean;
    backgroundWork?: boolean;
    workbenchNetworkAllowlist?: boolean;
  };
};

/**
 * The single startup payload served by `GET /api/bootstrap`: the session, plus
 * (when signed in) the default agent settings and thread list. Collapses the
 * old `getSession → (settings + threads)` chain into one round trip. `settings`
 * is `null` when the user owns no workspace with a default agent.
 */
export interface BootstrapData {
  session: AuthSession;
  settings: AgentSettingsResponse | null;
  threads: ThreadSummary[];
  threadsNextCursor: string | null;
  projects: ProjectSummary[];
  voiceEnabled: boolean;
  workersAiEnabled: boolean;
  feedbackAdminEnabled: boolean;
  backgroundWorkEnabled: boolean;
  workbenchNetworkAllowlistEnabled: boolean;
}

export async function getBootstrap(fetchImpl: FetchLike = appFetch): Promise<BootstrapData> {
  const res = await fetchImpl("/api/bootstrap", { credentials: "include" });
  if (!res.ok) throw new Error(`bootstrap_failed_${res.status}`);

  return parseBootstrap((await res.json()) as BootstrapPayload);
}

export function parseBootstrap(data: BootstrapPayload): BootstrapData {

  const session: AuthSession =
    data.session?.authenticated && data.session.user
      ? { authenticated: true, user: data.session.user }
      : { authenticated: false };

  return {
    session,
    settings: data.settings ?? null,
    threads: data.threads ?? [],
    threadsNextCursor: data.threadsNextCursor ?? null,
    projects: data.projects ?? [],
    voiceEnabled: data.features?.voiceInput ?? false,
    workersAiEnabled: data.features?.workersAi ?? false,
    feedbackAdminEnabled: data.features?.feedbackAdmin ?? false,
    backgroundWorkEnabled: data.features?.backgroundWork ?? false,
    workbenchNetworkAllowlistEnabled: data.features?.workbenchNetworkAllowlist ?? false,
  };
}
