import type { AuthSession } from "./auth-api";
import { appFetch } from "./lib/app-fetch";
import type { ProjectSummary } from "./projects-api";
import type { AgentSettingsResponse } from "./settings-api";
import type { ThreadSummary } from "./threads-api";

type FetchLike = typeof fetch;

/** Mirrors src/app-name.ts. Duplicated rather than imported: `web/` is a
 *  separate package that does not build against the Worker source. */
export const DEFAULT_APP_NAME = "Nadi";

type BootstrapPayload = {
  appName?: string;
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
    agentNetworkAllowlist?: boolean;
  };
};

/**
 * The single startup payload served by `GET /api/bootstrap`: the session, plus
 * (when signed in) the default agent settings and thread list. Collapses the
 * old `getSession → (settings + threads)` chain into one round trip. `settings`
 * is `null` when the user owns no workspace with a default agent.
 */
export interface BootstrapData {
  /** The deployment's display name (`APP_NAME`), used as the in-app document
   *  title. Served on both the signed-in and signed-out responses, because the
   *  sign-in screen is already the app rather than the landing page. */
  appName: string;
  session: AuthSession;
  settings: AgentSettingsResponse | null;
  threads: ThreadSummary[];
  threadsNextCursor: string | null;
  projects: ProjectSummary[];
  voiceEnabled: boolean;
  workersAiEnabled: boolean;
  feedbackAdminEnabled: boolean;
  backgroundWorkEnabled: boolean;
  agentNetworkAllowlistEnabled: boolean;
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

  const appName = typeof data.appName === "string" ? data.appName.trim() : "";

  return {
    appName: appName || DEFAULT_APP_NAME,
    session,
    settings: data.settings ?? null,
    threads: data.threads ?? [],
    threadsNextCursor: data.threadsNextCursor ?? null,
    projects: data.projects ?? [],
    voiceEnabled: data.features?.voiceInput ?? false,
    workersAiEnabled: data.features?.workersAi ?? false,
    feedbackAdminEnabled: data.features?.feedbackAdmin ?? false,
    backgroundWorkEnabled: data.features?.backgroundWork ?? false,
    agentNetworkAllowlistEnabled: data.features?.agentNetworkAllowlist ?? false,
  };
}
