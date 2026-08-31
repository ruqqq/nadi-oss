import { validateRequestSession } from "../auth/session";
import { registryDb } from "../db/client";
import { GithubInstallationRepository } from "../db/repositories/github-installations";
import { WorkspaceRepository } from "../db/repositories/workspaces";
import type { Env } from "../env";
import { getGithubAppConfig, type GithubAppConfig } from "../github/config";
import { GithubAppClient, GithubInstallationGoneError } from "../github/app-client";
import { signGithubState, verifyGithubState } from "../github/state";
import { resolveAgentScope } from "./agent-scope";

interface GithubRouteDeps {
  clientFactory?: (config: GithubAppConfig) => GithubAppClient;
  nowMs?: () => number;
}

async function resolveOwnerWorkspace(
  req: Request,
  env: Env,
): Promise<{ ok: true; workspaceId: string; userId: string } | { ok: false; response: Response }> {
  const session = await validateRequestSession(env, req);
  if (!session) return { ok: false, response: new Response("Unauthorized", { status: 401 }) };
  const workspace = await new WorkspaceRepository(registryDb(env)).getCurrentWorkspaceForOwner(
    session.user.id,
  );
  if (!workspace) return { ok: false, response: new Response("Not found", { status: 404 }) };
  return { ok: true, workspaceId: workspace.id, userId: session.user.id };
}

export async function routeGithub(
  req: Request,
  env: Env,
  deps: GithubRouteDeps = {},
): Promise<Response | null> {
  const url = new URL(req.url);
  const now = deps.nowMs ?? (() => Date.now());
  const makeClient = (config: GithubAppConfig) =>
    deps.clientFactory ? deps.clientFactory(config) : new GithubAppClient({ config });

  const installationRepoMatch = url.pathname.match(
    /^\/api\/settings\/github\/installations\/([^/]+)\/repositories$/,
  );
  if (installationRepoMatch) {
    if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
    return listInstallationRepositories(req, env, url, installationRepoMatch[1]!, makeClient);
  }

  if (
    url.pathname !== "/api/settings/github" &&
    url.pathname !== "/api/settings/github/disconnect" &&
    url.pathname !== "/api/settings/github/connect" &&
    url.pathname !== "/api/github/callback"
  ) {
    return null;
  }

  // --- Unauthenticated GitHub callback ---
  if (url.pathname === "/api/github/callback" && req.method === "GET") {
    const config = getGithubAppConfig(env);
    if (!config) {
      return Response.redirect(
        new URL("/settings/github?error=not_configured", req.url).toString(),
        302,
      );
    }
    const session = await validateRequestSession(env, req);
    const state = url.searchParams.get("state") ?? "";
    const payload = await verifyGithubState(config.clientSecret, state, now());
    const installationId = Number(url.searchParams.get("installation_id"));
    const code = url.searchParams.get("code") ?? "";
    if (
      !payload ||
      !session ||
      session.user.id !== payload.userId ||
      !Number.isFinite(installationId)
    ) {
      return Response.redirect(
        new URL("/settings/github?error=invalid_state", req.url).toString(),
        302,
      );
    }
    const stillOwner = await new WorkspaceRepository(registryDb(env)).isOwner(
      payload.workspaceId,
      session.user.id,
    );
    if (!stillOwner) {
      return Response.redirect(
        new URL("/settings/github?error=invalid_state", req.url).toString(),
        302,
      );
    }
    try {
      const client = makeClient(config);
      const { accessToken } = await client.exchangeOAuthCode(code);
      await client.getAuthenticatedUser(accessToken); // confirm identity; token discarded, not persisted
      const installation = await client.getInstallation(installationId);
      await new GithubInstallationRepository(registryDb(env)).upsert({
        workspaceId: payload.workspaceId,
        installationId,
        accountLogin: installation.accountLogin,
        accountType: installation.accountType,
        repositorySelection: installation.repositorySelection,
        connectedByUserId: payload.userId,
      });
      return Response.redirect(new URL("/settings/github?connected=1", req.url).toString(), 302);
    } catch {
      return Response.redirect(
        new URL("/settings/github?error=callback_failed", req.url).toString(),
        302,
      );
    }
  }

  // --- Owner-gated connect redirect ---
  if (url.pathname === "/api/settings/github/connect" && req.method === "GET") {
    const config = getGithubAppConfig(env);
    if (!config) return new Response("Not configured", { status: 404 });
    const target = await resolveOwnerWorkspace(req, env);
    if (!target.ok) return target.response;
    const state = await signGithubState(config.clientSecret, {
      workspaceId: target.workspaceId,
      userId: target.userId,
      nonce: crypto.randomUUID(),
      exp: now() + 10 * 60_000,
    });
    const dest = new URL(`https://github.com/apps/${config.slug}/installations/new`);
    dest.searchParams.set("state", state);
    return Response.redirect(dest.toString(), 302);
  }

  if (url.pathname === "/api/settings/github") {
    if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
    const target = await resolveOwnerWorkspace(req, env);
    if (!target.ok) return target.response;
    const rows = await new GithubInstallationRepository(registryDb(env)).listForWorkspace(
      target.workspaceId,
    );
    return Response.json({
      configured: getGithubAppConfig(env) !== null,
      installations: rows.map((r) => ({
        id: r.id,
        installationId: r.installationId,
        accountLogin: r.accountLogin,
        accountType: r.accountType,
        repositorySelection: r.repositorySelection,
        status: r.status,
        connectedByUserId: r.connectedByUserId,
        updatedAt: r.updatedAt,
      })),
    });
  }

  // /api/settings/github/disconnect
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const target = await resolveOwnerWorkspace(req, env);
  if (!target.ok) return target.response;
  const body = (await req.json().catch(() => null)) as { installationId?: number } | null;
  if (!body || typeof body.installationId !== "number") {
    return new Response("Bad request", { status: 400 });
  }
  const db = registryDb(env);
  const installRepo = new GithubInstallationRepository(db);
  await installRepo.markStatus(target.workspaceId, body.installationId, "disconnected");
  // TODO: reconcile access_status on agent_repositories referencing this installation (deferred)
  return Response.json({ ok: true });
}

async function listInstallationRepositories(
  req: Request,
  env: Env,
  url: URL,
  installationIdParam: string,
  makeClient: (config: GithubAppConfig) => GithubAppClient,
): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const installationId = Number(installationIdParam);
  if (!Number.isFinite(installationId)) return new Response("Not found", { status: 404 });

  const scope = await resolveAgentScope(env, session);
  if (!scope) return new Response("Not found", { status: 404 });

  const installations = await new GithubInstallationRepository(registryDb(env)).listForWorkspace(
    scope.workspaceId,
  );
  const installation = installations.find((i) => i.installationId === installationId);
  if (!installation) return new Response("Not found", { status: 404 });

  const config = getGithubAppConfig(env);
  if (!config) return new Response("Not configured", { status: 404 });

  const pageParam = url.searchParams.get("page");
  const page = pageParam ? Number(pageParam) : undefined;

  const db = registryDb(env);

  try {
    const client = makeClient(config);
    const { repositories, hasNextPage } = await client.listInstallationRepositories(
      installationId,
      page !== undefined && Number.isFinite(page) ? { page } : undefined,
    );
    return Response.json({ repositories, hasNextPage });
  } catch (error) {
    if (error instanceof GithubInstallationGoneError) {
      await new GithubInstallationRepository(db).markStatus(
        scope.workspaceId,
        installationId,
        "disconnected",
      );
      // TODO: reconcile access_status on agent_repositories referencing this installation (deferred)
      return Response.json({ error: "installation_disconnected" }, { status: 409 });
    }
    throw error;
  }
}
