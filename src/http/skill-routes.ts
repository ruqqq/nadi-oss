import type { Env } from "../env";
import { validateRequestSession, type ValidatedSession } from "../auth/session";
import { registryDb } from "../db/client";
import {
  AgentSkillDuplicateError,
  AgentSkillRepository,
  type LibrarySkillForAgent,
} from "../db/repositories/agent-skills";
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

  // Both scope moves live under /api/skills/ (not /api/agents/): the SKILL is
  // what is being moved, and `routeAgents` — which runs first and catch-all
  // 404s /api/agents/ — never sees these.
  const moveId = matchId(url.pathname, /^\/api\/skills\/([^/]+)\/move-to-library$/);
  if (moveId !== null) {
    if (req.method === "POST") return moveSkillToLibrary(req, env, moveId);
    return new Response("Method not allowed", { status: 405 });
  }

  const copyId = matchId(url.pathname, /^\/api\/skills\/([^/]+)\/copy-to-agent$/);
  if (copyId !== null) {
    if (req.method === "POST") return copySkillToAgent(req, env, copyId);
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

/**
 * The workspace library as it applies to ONE agent, plus that agent's own.
 *
 * Two groups, not one merged list: the library rows are shared and are edited
 * on the Skills tab (this agent can only opt out of them), while `own` is
 * this agent's private set. Merging them would make "delete" mean two
 * different things in one list.
 */
export async function listAgentSkills(req: Request, env: Env, agentId: string): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });
  const scope = await resolveAgentScopeById(env, session, agentId);
  if (!scope) return new Response("Not found", { status: 404 });
  const repo = new AgentSkillRepository(registryDb(env));
  const [library, own] = await Promise.all([
    repo.listLibraryForAgent(scope),
    repo.listActive(scope, { includeDisabled: true }),
  ]);
  return Response.json({
    library: library.map(serializeLibraryForAgent),
    own: own.map(serialize),
  });
}

/**
 * Opt one agent in or out of one workspace-library skill.
 *
 * Both ids come off the URL and BOTH are checked against the session's
 * workspace: `resolveAgentScopeById` answers for the agent, and
 * `getLibrarySkillById` answers for the skill. Checking only the agent would
 * let a guessed skill id write an `agent_skill_exclusions` row pointing at
 * another workspace's skill; checking only the skill would let a member
 * silently reconfigure someone else's agent.
 */
export async function setSkillExclusion(
  req: Request,
  env: Env,
  agentId: string,
  skillId: string,
): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });
  const body = (await req.json().catch(() => null)) as { excluded?: unknown } | null;
  if (typeof body?.excluded !== "boolean")
    return new Response("excluded must be a boolean", { status: 400 });
  const scope = await resolveAgentScopeById(env, session, agentId);
  if (!scope) return new Response("Not found", { status: 404 });
  const repo = new AgentSkillRepository(registryDb(env));
  // Only a LIVE LIBRARY skill in this workspace can be excluded. An
  // agent-private skill is archived, not excluded, so an exclusion row on one
  // would be a row `listEffective` never reads - a toggle that appears to work
  // and changes nothing.
  const skill = await repo.getLibrarySkillById({ workspaceId: scope.workspaceId, skillId });
  if (!skill) return new Response("Not found", { status: 404 });
  if (body.excluded) await repo.excludeLibrarySkill({ agentId: scope.agentId, skillId: skill.id });
  else await repo.includeLibrarySkill({ agentId: scope.agentId, skillId: skill.id });
  return new Response(null, { status: 204 });
}

function serializeLibraryForAgent(s: LibrarySkillForAgent) {
  return {
    ...serialize(s),
    excluded: s.excluded,
    shadowedByOwnSkillId: s.shadowedByOwnSkillId,
  };
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
  const archived = url.searchParams.get("archived") === "1";
  const rows = archived
    ? await repo.listArchived(scope)
    : await repo.listActive(scope, { includeDisabled: true });
  // LIBRARY scope only, and never on the archived tab: `countAgentsLiveOn`
  // requires `archived_at IS NULL`, so every answer there is zero and the query
  // is a D1 round-trip that cannot say anything. On an agent's own skills the
  // number would always read 1 - noise.
  if (scope.agentId !== null || archived) return Response.json({ skills: rows.map(serialize) });
  const counts = await repo.countAgentsLiveOn(rows.map((row) => row.id));
  return Response.json({
    skills: rows.map((row) => ({ ...serialize(row), liveOnAgentCount: counts.get(row.id) ?? 0 })),
  });
}

/**
 * Promote one agent's private skill into the shared workspace library.
 *
 * The skill is agent-private, so the request must name its scope with
 * `?agentId=` — the same query parameter every other write on this route uses.
 * Without it `resolveSkillScope` resolves the LIBRARY, where a private id does
 * not exist, and the caller would get an unexplained 404.
 */
async function moveSkillToLibrary(req: Request, env: Env, id: string): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });
  const scope = await resolveSkillScope(env, session, new URL(req.url));
  if (!scope) return new Response("Not found", { status: 404 });
  if (scope.agentId === null)
    return new Response("Name the agent this skill belongs to with ?agentId=", { status: 400 });
  const repo = new AgentSkillRepository(registryDb(env));
  try {
    const updated = await repo.moveToLibrary({
      workspaceId: scope.workspaceId,
      agentId: scope.agentId,
      id,
    });
    if (!updated) return new Response("Not found", { status: 404 });
    return Response.json({ skill: serialize(updated) });
  } catch (error) {
    if (error instanceof AgentSkillDuplicateError)
      return new Response("A library skill with this name is already active", { status: 409 });
    throw error;
  }
}

/**
 * Copy a skill onto one agent as its own — normally a library skill an agent
 * wants to fork and customise.
 *
 * BOTH ends are authorized against the session: the source through
 * `resolveSkillScope` (library by default, `?agentId=` for another agent's
 * private one) and the destination through `resolveAgentScopeById`. Trusting
 * the body's `agentId` alone would let a member drop a skill onto an agent in a
 * workspace they are not in.
 */
async function copySkillToAgent(req: Request, env: Env, id: string): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });
  const body = (await req.json().catch(() => null)) as { agentId?: unknown } | null;
  if (typeof body?.agentId !== "string" || body.agentId.length === 0)
    return new Response("agentId must be a string", { status: 400 });
  const scope = await resolveSkillScope(env, session, new URL(req.url));
  if (!scope) return new Response("Not found", { status: 404 });
  const target = await resolveAgentScopeById(env, session, body.agentId);
  // Same workspace as the skill: a member of two workspaces must not be able to
  // carry one workspace's skill into the other.
  if (!target || target.workspaceId !== scope.workspaceId)
    return new Response("Not found", { status: 404 });
  const repo = new AgentSkillRepository(registryDb(env));
  try {
    const created = await repo.copyToAgent({
      workspaceId: scope.workspaceId,
      agentId: scope.agentId,
      id,
      targetAgentId: target.agentId,
    });
    if (!created) return new Response("Not found", { status: 404 });
    return Response.json({ skill: serialize(created) });
  } catch (error) {
    if (error instanceof AgentSkillDuplicateError)
      return new Response("That agent already has a skill with this name", { status: 409 });
    throw error;
  }
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
