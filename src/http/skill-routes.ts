import type { Env } from "../env";
import { validateRequestSession, type ValidatedSession } from "../auth/session";
import { registryDb } from "../db/client";
import { AgentSkillDuplicateError, AgentSkillRepository } from "../db/repositories/agent-skills";
import type { Skill } from "../db/schema";
import { resolveAgentScope, resolveAgentScopeById } from "./agent-scope";

export async function routeSkills(req: Request, env: Env): Promise<Response | null> {
  const url = new URL(req.url);

  if (url.pathname === "/api/skills") {
    if (req.method === "GET") return listSkills(req, env, url);
    return new Response("Method not allowed", { status: 405 });
  }

  const enabledId = matchId(url.pathname, /^\/api\/skills\/([^/]+)\/enabled$/);
  if (enabledId !== null) {
    if (req.method === "POST") return setEnabled(req, env, enabledId);
    return new Response("Method not allowed", { status: 405 });
  }

  const archiveId = matchId(url.pathname, /^\/api\/skills\/([^/]+)\/archive$/);
  if (archiveId !== null) {
    if (req.method === "POST") return archiveSkill(req, env, archiveId);
    return new Response("Method not allowed", { status: 405 });
  }

  const restoreId = matchId(url.pathname, /^\/api\/skills\/([^/]+)\/restore$/);
  if (restoreId !== null) {
    if (req.method === "POST") return restoreSkill(req, env, restoreId);
    return new Response("Method not allowed", { status: 405 });
  }

  if (url.pathname.startsWith("/api/skills")) {
    return new Response("Not found", { status: 404 });
  }
  return null;
}

/**
 * Which skills a request is about.
 *
 * With no `agentId`, this route is the workspace LIBRARY (`agentId: null`) —
 * the shared skills every agent inherits, which is what the Skills settings tab
 * manages. With `?agentId=`, it is that one agent's private skills, which is
 * what an agent's own drill-down shows. Before two-scope skills existed this
 * route resolved to "the workspace's earliest agent", which after the library
 * promotion would have shown an almost empty list under a tab labelled as the
 * workspace's skills.
 */
async function resolveSkillScope(
  env: Env,
  session: ValidatedSession,
  url: URL,
): Promise<{ workspaceId: string; agentId: string | null } | null> {
  const agentId = url.searchParams.get("agentId");
  if (agentId) return resolveAgentScopeById(env, session, agentId);
  const scope = await resolveAgentScope(env, session);
  return scope ? { workspaceId: scope.workspaceId, agentId: null } : null;
}

function serialize(s: Skill) {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    body: s.body,
    enabled: s.enabled,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    archivedAt: s.archivedAt,
  };
}

async function listSkills(req: Request, env: Env, url: URL): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });
  const scope = await resolveSkillScope(env, session, url);
  if (!scope) return Response.json({ skills: [] });
  const repo = new AgentSkillRepository(registryDb(env));
  const rows =
    url.searchParams.get("archived") === "1"
      ? await repo.listArchived(scope)
      : await repo.listActive(scope, { includeDisabled: true });
  return Response.json({ skills: rows.map(serialize) });
}

async function setEnabled(req: Request, env: Env, id: string): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });
  const body = (await req.json().catch(() => null)) as { enabled?: unknown } | null;
  if (typeof body?.enabled !== "boolean")
    return new Response("enabled must be a boolean", { status: 400 });
  const scope = await resolveSkillScope(env, session, new URL(req.url));
  if (!scope) return new Response("Not found", { status: 404 });
  const updated = await new AgentSkillRepository(registryDb(env)).setEnabled({
    ...scope,
    id,
    enabled: body.enabled,
  });
  if (!updated) return new Response("Not found", { status: 404 });
  return Response.json({ skill: serialize(updated) });
}

async function archiveSkill(req: Request, env: Env, id: string): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });
  const scope = await resolveSkillScope(env, session, new URL(req.url));
  if (!scope) return new Response("Not found", { status: 404 });
  const updated = await new AgentSkillRepository(registryDb(env)).archiveById({ ...scope, id });
  if (!updated) return new Response("Not found", { status: 404 });
  return Response.json({ skill: serialize(updated) });
}

async function restoreSkill(req: Request, env: Env, id: string): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });
  const scope = await resolveSkillScope(env, session, new URL(req.url));
  if (!scope) return new Response("Not found", { status: 404 });
  try {
    const updated = await new AgentSkillRepository(registryDb(env)).restore({ ...scope, id });
    if (!updated) return new Response("Not found", { status: 404 });
    return Response.json({ skill: serialize(updated) });
  } catch (error) {
    if (error instanceof AgentSkillDuplicateError)
      return new Response("A skill with this name is already active", { status: 409 });
    throw error;
  }
}

function matchId(pathname: string, re: RegExp): string | null {
  const m = pathname.match(re);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}
