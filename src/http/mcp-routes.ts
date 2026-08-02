import { asc, eq } from "drizzle-orm";
import { getAgentByName } from "agents";
import type { Env } from "../env";
import { validateRequestSession, type ValidatedSession } from "../auth/session";
import { registryDb } from "../db/client";
import { workspaceMembers } from "../db/schema";
import { McpServerRepository, type ToolPolicy } from "../db/repositories/mcp-servers";
import { WorkspaceRepository } from "../db/repositories/workspaces";
import { mergeServerTools } from "../mcp/merge-tools";
import { clearMcpOAuthCredentials } from "../mcp/oauth-store";

const VALID_POLICIES: ToolPolicy[] = ["auto_allow", "approval_required", "deny"];

export async function routeMcp(req: Request, env: Env): Promise<Response | null> {
  const url = new URL(req.url);

  if (url.pathname === "/api/mcp/servers") {
    if (req.method === "GET") return listServers(req, env);
    if (req.method === "POST") return createServer(req, env);
    return new Response("Method not allowed", { status: 405 });
  }

  const policiesServerId = matchId(url.pathname, /^\/api\/mcp\/servers\/([^/]+)\/policies$/);
  if (policiesServerId !== null) {
    if (req.method === "PUT") return setPolicies(req, env, policiesServerId);
    return new Response("Method not allowed", { status: 405 });
  }

  const toolsServerId = matchId(url.pathname, /^\/api\/mcp\/servers\/([^/]+)\/tools$/);
  if (toolsServerId !== null) {
    if (req.method === "GET") return listServerTools(req, env, toolsServerId);
    return new Response("Method not allowed", { status: 405 });
  }

  const authorizeServerId = matchId(url.pathname, /^\/api\/mcp\/servers\/([^/]+)\/authorize$/);
  if (authorizeServerId !== null) {
    if (req.method === "POST") return authorizeServer(req, env, authorizeServerId);
    return new Response("Method not allowed", { status: 405 });
  }

  const serverId = matchId(url.pathname, /^\/api\/mcp\/servers\/([^/]+)$/);
  if (serverId !== null) {
    if (req.method === "PATCH") return updateServer(req, env, serverId);
    if (req.method === "DELETE") return deleteServer(req, env, serverId);
    return new Response("Method not allowed", { status: 405 });
  }

  if (url.pathname.startsWith("/api/mcp/")) {
    return new Response("Not found", { status: 404 });
  }
  return null;
}

// Nadi is single-workspace-per-user today, so we resolve the caller's workspace
// as their earliest membership — the same selection `selectThreadTarget` uses in
// thread-routes.ts. Revisit when multi-workspace support lands (callers will then
// need to specify the target workspace).
async function resolveWorkspaceId(env: Env, session: ValidatedSession): Promise<string | null> {
  const row = await registryDb(env)
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, session.user.id))
    .orderBy(asc(workspaceMembers.createdAt))
    .get();
  return row?.workspaceId ?? null;
}

function serialize(s: {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  createdAt: number;
}) {
  return { id: s.id, name: s.name, url: s.url, enabled: s.enabled, createdAt: s.createdAt };
}

async function listServers(req: Request, env: Env): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });
  const workspaceId = await resolveWorkspaceId(env, session);
  if (!workspaceId) return Response.json({ servers: [] });
  const servers = await new McpServerRepository(registryDb(env)).list(workspaceId);
  return Response.json({ servers: servers.map(serialize) });
}

async function createServer(req: Request, env: Env): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });
  const body = (await req.json().catch(() => null)) as { name?: unknown; url?: unknown } | null;
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const url = typeof body?.url === "string" ? body.url.trim() : "";
  if (!name) return new Response("name is required", { status: 400 });
  if (!isHttpUrl(url)) return new Response("url must be a valid http(s) URL", { status: 400 });

  const workspaceId = await resolveWorkspaceId(env, session);
  if (!workspaceId) return new Response("Workspace not found", { status: 404 });
  const server = await new McpServerRepository(registryDb(env)).create(workspaceId, { name, url });
  return Response.json({ server: serialize(server) }, { status: 201 });
}

async function updateServer(req: Request, env: Env, id: string): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });
  const db = registryDb(env);
  const repo = new McpServerRepository(db);
  const existing = await repo.getById(id);
  if (!existing) return new Response("Not found", { status: 404 });
  try {
    await new WorkspaceRepository(db).assertMember({
      workspaceId: existing.workspaceId,
      userId: session.user.id,
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }

  const body = (await req.json().catch(() => null)) as { name?: unknown; enabled?: unknown } | null;
  const patch: { name?: string; enabled?: boolean } = {};
  if (typeof body?.name === "string" && body.name.trim()) patch.name = body.name.trim();
  if (typeof body?.enabled === "boolean") patch.enabled = body.enabled;
  if (Object.keys(patch).length === 0)
    return new Response("No valid fields to update", { status: 400 });

  const updated = await repo.update(id, patch);
  return Response.json({ server: serialize(updated!) });
}

async function deleteServer(req: Request, env: Env, id: string): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });
  const db = registryDb(env);
  const repo = new McpServerRepository(db);
  const existing = await repo.getById(id);
  if (!existing) return new Response("Not found", { status: 404 });
  try {
    await new WorkspaceRepository(db).assertMember({
      workspaceId: existing.workspaceId,
      userId: session.user.id,
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
  await repo.delete(id);
  // The repo is pure-D1 (policy rows cascade there); KV token cleanup must
  // happen here where we have `env`/secret access.
  await clearMcpOAuthCredentials(env, existing.workspaceId, id);
  // Evict the live connection in the management DO so a deleted server doesn't
  // linger as an orphaned (possibly still-authorized) connection.
  try {
    const stub = await getAgentByName(env.WORKSPACE_MCP_AGENT, `workspace:${existing.workspaceId}`);
    await stub.evictServer(id);
  } catch {
    /* best-effort: deletion already succeeded in D1 + KV */
  }
  return new Response(null, { status: 204 });
}

async function authorizeServer(req: Request, env: Env, id: string): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });
  const db = registryDb(env);
  const repo = new McpServerRepository(db);
  const server = await repo.getById(id);
  if (!server) return new Response("Not found", { status: 404 });
  try {
    await new WorkspaceRepository(db).assertMember({
      workspaceId: server.workspaceId,
      userId: session.user.id,
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }

  const stub = await getAgentByName(env.WORKSPACE_MCP_AGENT, `workspace:${server.workspaceId}`);
  try {
    // Returns { authUrl } (consent required) or { ready: true } (already
    // authorized / no OAuth). The SPA opens authUrl; the anonymous callback
    // (routed in src/index.ts) completes the exchange and persists tokens.
    // NOTE (live-verify): the { authUrl } success branch needs a real OAuth MCP
    // server; only the 401/404 guards are exercised in-harness.
    const result = await stub.beginServerAuth(server.id, server.url);
    return Response.json(result);
  } catch (err) {
    return Response.json(
      {
        error: "authorize_failed",
        message: err instanceof Error ? err.message : "could not start authorization",
      },
      { status: 502 },
    );
  }
}

async function setPolicies(req: Request, env: Env, id: string): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });
  const db = registryDb(env);
  const repo = new McpServerRepository(db);
  const existing = await repo.getById(id);
  if (!existing) return new Response("Not found", { status: 404 });
  try {
    await new WorkspaceRepository(db).assertMember({
      workspaceId: existing.workspaceId,
      userId: session.user.id,
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }

  const body = (await req.json().catch(() => null)) as { policies?: unknown } | null;
  const raw = Array.isArray(body?.policies) ? body.policies : null;
  if (!raw) return new Response("policies must be an array", { status: 400 });
  const policies: Array<{ toolName: string; policy: ToolPolicy }> = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      return new Response("invalid policy entry", { status: 400 });
    }
    const toolName =
      typeof (entry as { toolName?: unknown }).toolName === "string"
        ? (entry as { toolName: string }).toolName
        : "";
    const policy = (entry as { policy?: unknown }).policy;
    if (!toolName) return new Response("each policy needs a toolName", { status: 400 });
    if (typeof policy !== "string" || !VALID_POLICIES.includes(policy as ToolPolicy)) {
      return new Response("invalid policy value", { status: 400 });
    }
    policies.push({ toolName, policy: policy as ToolPolicy });
  }

  const saved = await repo.setPolicies(existing.workspaceId, id, policies);
  return Response.json({
    policies: saved.map((p) => ({ toolName: p.toolName, policy: p.policy })),
  });
}

async function listServerTools(req: Request, env: Env, id: string): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });
  const db = registryDb(env);
  const repo = new McpServerRepository(db);
  const server = await repo.getById(id);
  if (!server) return new Response("Not found", { status: 404 });
  try {
    await new WorkspaceRepository(db).assertMember({
      workspaceId: server.workspaceId,
      userId: session.user.id,
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }

  const stub = await getAgentByName(env.WORKSPACE_MCP_AGENT, `workspace:${server.workspaceId}`);
  let result;
  try {
    result = await stub.listServerTools(server.id, server.url);
  } catch (err) {
    return Response.json(
      {
        error: "discovery_failed",
        message: err instanceof Error ? err.message : "could not reach the server",
      },
      { status: 502 },
    );
  }

  if ("needsAuth" in result) {
    return Response.json({ needsAuth: true, tools: [] });
  }

  const policyRows = await repo.listPolicies(server.id);
  const policyByToolName: Record<string, ToolPolicy> = {};
  for (const row of policyRows) policyByToolName[row.toolName] = row.policy;

  return Response.json({
    needsAuth: false,
    tools: mergeServerTools(result.tools, policyByToolName),
  });
}

function matchId(pathname: string, re: RegExp): string | null {
  const m = pathname.match(re);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}
