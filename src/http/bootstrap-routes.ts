import type { Env } from "../env";
import { resolveAppName } from "../app-name";
import {
  backgroundWorkEnabled,
  isTruthyFlag,
  resolveWorkspaceBackgroundWork,
  resolveWorkspaceWorkbenchNetworkAllowlist,
} from "../flags";
import { validateRequestSession } from "../auth/session";
import { canUseProvider } from "../auth/provider-gate";
import { registryDb } from "../db/client";
import { agents, workspaceMembers, workspaces } from "../db/schema";
import { resolveAgentScope } from "./agent-scope";
import { ProjectRepository } from "../db/repositories/projects";
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

  const [settings, { threads, nextCursor: threadsNextCursor }, projects, scope] = await Promise.all(
    [
      buildDefaultAgentSettingsForUser(env, session.user.id, session.user.email),
      selectThreadSummariesForUser(env, session.user.id, "active", "all", {
        limit: DEFAULT_THREAD_PAGE,
      }),
      selectProjectSummariesForUser(env, session.user.id),
      resolveAgentScope(env, session),
    ],
  );
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
    features: {
      voiceInput: isTruthyFlag(env.VOICE_INPUT_ENABLED),
      workersAi: canUseProvider(env, "workers-ai", session.user.email),
      feedbackAdmin: isFeedbackAdmin(env, session.user.email),
      backgroundWork: resolveWorkspaceBackgroundWork({
        deploymentEnabled: backgroundWorkEnabled(env),
        flagsJson: workspace?.flagsJson ?? "{}",
      }),
      workbenchNetworkAllowlist: resolveWorkspaceWorkbenchNetworkAllowlist(
        workspace?.flagsJson ?? "{}",
      ),
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
