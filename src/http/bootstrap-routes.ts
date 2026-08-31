import type { Env } from "../env";
import { resolveAppName } from "../app-name";
import {
  anyBackgroundWorkEnabled,
  backgroundWorkEnabled,
  voiceInputEnabled,
  resolveWorkspaceBackgroundCapabilities,
  resolveWorkspaceAgentNetworkAllowlist,
} from "../flags";
import { validateRequestSession } from "../auth/session";
import { canUseProvider } from "../auth/provider-gate";
import { registryDb } from "../db/client";
import { agents, workspaceMembers, workspaces } from "../db/schema";
import { resolveAgentScope } from "./agent-scope";
import { ProjectRepository } from "../db/repositories/projects";
import { AgentRepository } from "../db/repositories/agents";
import { buildSummary, type AgentSummary } from "./agent-routes";
import { isFeedbackAdmin } from "../feedback/admin-auth";
import { buildDefaultAgentSettingsForUser } from "./settings-routes";
import { asc, eq } from "drizzle-orm";
import { DEFAULT_THREAD_PAGE, selectThreadSummariesForUser } from "./thread-routes";

/**
 * `GET /api/bootstrap` — everything the web app needs on first paint in one
 * response: the session plus (for a signed-in user) the default agent settings
 * and thread list. Collapses the startup `get-session → (settings + threads)`
 * chain into a single round trip. Settings and threads are resolved in parallel
 * server-side, so there's no extra client latency.
 *
 * `settings` is `null` when the user owns no workspace with a default agent —
 * the client falls open (no onboarding) rather than treating it as an error.
 */
export async function routeBootstrap(req: Request, env: Env): Promise<Response | null> {
  const url = new URL(req.url);
  if (url.pathname !== "/api/bootstrap") return null;
  if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });

  const session = await validateRequestSession(env, req);
  // appName rides on BOTH branches: the sign-in screen is already the app,
  // not the landing page, so it needs the title before there is a session.
  const appName = resolveAppName(env);
  if (!session) return Response.json({ appName, session: { authenticated: false } });

  const [settings, { threads, nextCursor: threadsNextCursor }, projects, agentsForUser, scope] =
    await Promise.all([
      buildDefaultAgentSettingsForUser(env, session.user.id, session.user.email),
      selectThreadSummariesForUser(env, session.user.id, "active", "all", {
        limit: DEFAULT_THREAD_PAGE,
      }),
      selectProjectSummariesForUser(env, session.user.id),
      selectAgentSummariesForUser(env, session.user.id),
      resolveAgentScope(env, session),
    ]);
  const workspace = scope
    ? await registryDb(env)
        .select({ flagsJson: workspaces.flagsJson })
        .from(workspaces)
        .where(eq(workspaces.id, scope.workspaceId))
        .get()
    : null;

  return Response.json({
    appName,
    session: { authenticated: true, user: { id: session.user.id, email: session.user.email } },
    settings,
    threads,
    threadsNextCursor,
    projects,
    agents: agentsForUser,
    features: {
      // Resolved through voiceInputEnabled so bootstrap and VoiceAgent agree:
      // the flag can only turn voice off, never on where the platform has no
      // speech-to-text (celld has no AI binding).
      voiceInput: voiceInputEnabled(env),
      workersAi: canUseProvider(env, "workers-ai", session.user.email),
      feedbackAdmin: isFeedbackAdmin(env, session.user.email),
      // The OR of both capabilities: this flag answers only "should the dock
      // exist", and the dock lists rows of either kind. A workspace with just
      // one capability still needs it.
      backgroundWork: anyBackgroundWorkEnabled(
        resolveWorkspaceBackgroundCapabilities({
          deploymentEnabled: backgroundWorkEnabled(env),
          flagsJson: workspace?.flagsJson ?? "{}",
        }),
      ),
      agentNetworkAllowlist: resolveWorkspaceAgentNetworkAllowlist(workspace?.flagsJson ?? "{}"),
    },
  });
}

async function selectProjectSummariesForUser(env: Env, userId: string) {
  const db = registryDb(env);
  const scope = await db
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .innerJoin(agents, eq(agents.workspaceId, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId))
    .orderBy(asc(workspaceMembers.createdAt), asc(agents.createdAt))
    .get();
  if (!scope) return [];
  return new ProjectRepository(db).listForWorkspace(scope.workspaceId, "active");
}

/**
 * The workspace's active agents, for the client's agent pickers (project
 * defaults, thread creation, automaton targets). Serialized through the same
 * {@link buildSummary} `GET /api/agents` uses — every client-side agent type
 * is `AgentSummary` (`repositories`/`envVars`/`secretEnvNames`/
 * `networkDomainAllowlist`, not the raw `sandboxNetworkDomainAllowlist`
 * column), and a second hand-rolled mapping here is exactly how the two
 * would drift. This costs the same per-agent repositories/secret-names
 * queries `GET /api/agents` already pays; a workspace's agent count is small
 * enough that first paint is not the place to skip it and hand the client a
 * shape its own type disagrees with.
 */
async function selectAgentSummariesForUser(env: Env, userId: string): Promise<AgentSummary[]> {
  const db = registryDb(env);
  const scope = await db
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .innerJoin(agents, eq(agents.workspaceId, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId))
    .orderBy(asc(workspaceMembers.createdAt), asc(agents.createdAt))
    .get();
  if (!scope) return [];
  const repo = new AgentRepository(db);
  const rows = await repo.listForWorkspace(scope.workspaceId, "active");
  return Promise.all(rows.map((row) => buildSummary(env, repo, scope.workspaceId, row)));
}
