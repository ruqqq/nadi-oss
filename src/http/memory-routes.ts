import type { Env } from "../env";
import { validateRequestSession, type ValidatedSession } from "../auth/session";
import { registryDb } from "../db/client";
import { AgentMemoryRepository } from "../db/repositories/agent-memories";
import type { AgentMemory } from "../db/schema";
import { resolveAgentScope, resolveAgentScopeById } from "./agent-scope";

export async function routeMemories(req: Request, env: Env): Promise<Response | null> {
  const url = new URL(req.url);

  if (url.pathname === "/api/memories") {
    if (req.method === "GET") return listMemories(req, env, url);
    return new Response("Method not allowed", { status: 405 });
  }

  const archiveId = matchId(url.pathname, /^\/api\/memories\/([^/]+)\/archive$/);
  if (archiveId !== null) {
    if (req.method === "POST") return archiveMemory(req, env, archiveId);
    return new Response("Method not allowed", { status: 405 });
  }

  const restoreId = matchId(url.pathname, /^\/api\/memories\/([^/]+)\/restore$/);
  if (restoreId !== null) {
    if (req.method === "POST") return restoreMemory(req, env, restoreId);
    return new Response("Method not allowed", { status: 405 });
  }

  if (url.pathname.startsWith("/api/memories")) {
    return new Response("Not found", { status: 404 });
  }
  return null;
}

/**
 * Memories belong to an AGENT, and a workspace now has several. `?agentId=`
 * names which one — the agent drill-down passes it. Without it this falls back
 * to the workspace's earliest agent, which is what every pre-merge caller meant.
 */
async function resolveMemoryScope(
  env: Env,
  session: ValidatedSession,
  url: URL,
): Promise<{ workspaceId: string; agentId: string } | null> {
  const agentId = url.searchParams.get("agentId");
  if (agentId) return resolveAgentScopeById(env, session, agentId);
  return resolveAgentScope(env, session);
}

function serialize(m: AgentMemory) {
  return {
    id: m.id,
    title: m.title,
    kind: m.kind,
    content: m.content,
    sourceThreadId: m.sourceThreadId,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    archivedAt: m.archivedAt,
  };
}

async function listMemories(req: Request, env: Env, url: URL): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });
  const scope = await resolveMemoryScope(env, session, url);
  if (!scope) return Response.json({ memories: [] });
  const repo = new AgentMemoryRepository(registryDb(env));
  const rows =
    url.searchParams.get("archived") === "1"
      ? await repo.listArchived(scope)
      : await repo.listActive(scope);
  return Response.json({ memories: rows.map(serialize) });
}

async function archiveMemory(req: Request, env: Env, id: string): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });
  const scope = await resolveMemoryScope(env, session, new URL(req.url));
  if (!scope) return new Response("Not found", { status: 404 });
  const repo = new AgentMemoryRepository(registryDb(env));
  const ok = await repo.archive({ ...scope, id });
  if (!ok) return new Response("Not found", { status: 404 });
  const rows = await repo.listArchived(scope);
  const memory = rows.find((m) => m.id === id);
  if (!memory) return new Response("Not found", { status: 404 });
  return Response.json({ memory: serialize(memory) });
}

async function restoreMemory(req: Request, env: Env, id: string): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });
  const scope = await resolveMemoryScope(env, session, new URL(req.url));
  if (!scope) return new Response("Not found", { status: 404 });
  const restored = await new AgentMemoryRepository(registryDb(env)).restore({ ...scope, id });
  if (!restored) return new Response("Not found", { status: 404 });
  return Response.json({ memory: serialize(restored) });
}

function matchId(pathname: string, re: RegExp): string | null {
  const m = pathname.match(re);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}
