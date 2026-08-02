import type { Env } from "../env";
import { validateRequestSession } from "../auth/session";
import { registryDb } from "../db/client";
import { AgentSkillDuplicateError, AgentSkillRepository } from "../db/repositories/agent-skills";
import type { AgentSkill } from "../db/schema";
import { resolveAgentScope } from "./agent-scope";

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

function serialize(s: AgentSkill) {
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
  const scope = await resolveAgentScope(env, session);
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
  const scope = await resolveAgentScope(env, session);
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
  const scope = await resolveAgentScope(env, session);
  if (!scope) return new Response("Not found", { status: 404 });
  const updated = await new AgentSkillRepository(registryDb(env)).archiveById({ ...scope, id });
  if (!updated) return new Response("Not found", { status: 404 });
  return Response.json({ skill: serialize(updated) });
}

async function restoreSkill(req: Request, env: Env, id: string): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });
  const scope = await resolveAgentScope(env, session);
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
