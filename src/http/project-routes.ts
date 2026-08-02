import type { Env } from "../env";
import { validateRequestSession, type ValidatedSession } from "../auth/session";
import { registryDb } from "../db/client";
import { WorkbenchRepository } from "../db/repositories/workbenches";
import { ProjectRepository, type ProjectStatus } from "../db/repositories/projects";
import { WorkspaceRepository } from "../db/repositories/workspaces";
import { resolveAgentScope } from "./agent-scope";

type ProjectBody = {
  name?: unknown;
  description?: unknown;
  customInstructions?: unknown;
  defaultWorkbenchId?: unknown;
};

export async function routeProjects(req: Request, env: Env): Promise<Response | null> {
  const url = new URL(req.url);

  if (url.pathname === "/api/projects") {
    if (req.method === "GET") return listProjects(req, env, url);
    if (req.method === "POST") return createProject(req, env);
    return new Response("Method not allowed", { status: 405 });
  }

  const archiveProjectId = matchId(url.pathname, /^\/api\/projects\/([^/]+)\/archive$/);
  if (archiveProjectId !== null) {
    if (req.method === "POST") return archiveProject(req, env, archiveProjectId);
    return new Response("Method not allowed", { status: 405 });
  }

  const projectId = matchId(url.pathname, /^\/api\/projects\/([^/]+)$/);
  if (projectId !== null) {
    if (req.method === "GET") return getProject(req, env, projectId);
    if (req.method === "PATCH") return updateProject(req, env, projectId);
    return new Response("Method not allowed", { status: 405 });
  }

  if (url.pathname.startsWith("/api/projects/")) {
    return new Response("Not found", { status: 404 });
  }

  return null;
}

async function listProjects(req: Request, env: Env, url: URL): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const status = parseStatus(url.searchParams.get("status"));
  if (!status.ok) return status.response;

  const workspaceId = await resolveWorkspaceId(env, session);
  if (!workspaceId) return Response.json({ projects: [] });

  const projects = await new ProjectRepository(registryDb(env)).listForWorkspace(
    workspaceId,
    status.value,
  );
  return Response.json({ projects });
}

async function createProject(req: Request, env: Env): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const workspaceId = await resolveWorkspaceId(env, session);
  if (!workspaceId) return new Response("Workspace not found", { status: 404 });

  const body = (await req.json().catch(() => null)) as ProjectBody | null;
  const name = parseRequiredString(body?.name, "name");
  if (!name.ok) return name.response;
  const description = parseOptionalString(body?.description, "description");
  if (!description.ok) return description.response;
  const customInstructions = parseOptionalString(body?.customInstructions, "customInstructions");
  if (!customInstructions.ok) return customInstructions.response;

  const createdAt = Date.now();
  const project = await new ProjectRepository(registryDb(env)).create({
    id: `proj_${crypto.randomUUID()}`,
    workspaceId,
    name: name.value,
    description: description.value,
    customInstructions: customInstructions.value,
    createdAt,
    updatedAt: createdAt,
  });

  return Response.json({ project }, { status: 201 });
}

async function getProject(req: Request, env: Env, projectId: string): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const db = registryDb(env);
  const repo = new ProjectRepository(db);
  const project = await repo.getById(projectId);
  if (!project) return new Response("Not found", { status: 404 });

  try {
    await new WorkspaceRepository(db).assertMember({
      workspaceId: project.workspaceId,
      userId: session.user.id,
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }

  return Response.json({ project });
}

async function updateProject(req: Request, env: Env, projectId: string): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const db = registryDb(env);
  const repo = new ProjectRepository(db);
  const project = await repo.getById(projectId);
  if (!project) return new Response("Not found", { status: 404 });

  try {
    await new WorkspaceRepository(db).assertMember({
      workspaceId: project.workspaceId,
      userId: session.user.id,
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }

  const body = (await req.json().catch(() => null)) as ProjectBody | null;
  const patch: {
    name?: string;
    description?: string;
    customInstructions?: string;
    defaultWorkbenchId?: string | null;
    updatedAt?: number;
  } = {};

  if (body?.name !== undefined) {
    const name = parseRequiredString(body.name, "name");
    if (!name.ok) return name.response;
    patch.name = name.value;
  }

  if (body?.description !== undefined) {
    const description = parseOptionalString(body.description, "description");
    if (!description.ok) return description.response;
    patch.description = description.value;
  }

  if (body?.customInstructions !== undefined) {
    const customInstructions = parseOptionalString(body.customInstructions, "customInstructions");
    if (!customInstructions.ok) return customInstructions.response;
    patch.customInstructions = customInstructions.value;
  }

  if (body?.defaultWorkbenchId !== undefined) {
    const defaultWorkbenchId = await parseDefaultWorkbenchId(
      db,
      project.workspaceId,
      body.defaultWorkbenchId,
    );
    if (!defaultWorkbenchId.ok) return defaultWorkbenchId.response;
    patch.defaultWorkbenchId = defaultWorkbenchId.value;
  }

  if (Object.keys(patch).length === 0) {
    return new Response("No valid fields to update", { status: 400 });
  }

  patch.updatedAt = Date.now();
  await repo.update(projectId, patch);

  const updated = await repo.getById(projectId);
  if (!updated) return new Response("Not found", { status: 404 });
  return Response.json({ project: updated });
}

async function archiveProject(req: Request, env: Env, projectId: string): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const db = registryDb(env);
  const repo = new ProjectRepository(db);
  const project = await repo.getById(projectId);
  if (!project) return new Response("Not found", { status: 404 });

  try {
    await new WorkspaceRepository(db).assertMember({
      workspaceId: project.workspaceId,
      userId: session.user.id,
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }

  await repo.archive(projectId, Date.now());
  const archived = await repo.getById(projectId);
  if (!archived) return new Response("Not found", { status: 404 });
  return Response.json({ project: archived });
}

async function resolveWorkspaceId(env: Env, session: ValidatedSession): Promise<string | null> {
  return (await resolveAgentScope(env, session))?.workspaceId ?? null;
}

function parseStatus(
  value: string | null,
): { ok: true; value: ProjectStatus } | { ok: false; response: Response } {
  if (value === null || value === "active" || value === "archived" || value === "all") {
    return { ok: true, value: value ?? "active" };
  }
  return {
    ok: false,
    response: new Response("status must be active, archived, or all", { status: 400 }),
  };
}

function parseRequiredString(
  value: unknown,
  field: string,
): { ok: true; value: string } | { ok: false; response: Response } {
  if (typeof value !== "string" || !value.trim()) {
    return {
      ok: false,
      response: new Response(`${field} must be a non-empty string`, { status: 400 }),
    };
  }
  return { ok: true, value: value.trim() };
}

function parseOptionalString(
  value: unknown,
  field: string,
): { ok: true; value: string } | { ok: false; response: Response } {
  if (value === undefined) return { ok: true, value: "" };
  if (typeof value !== "string") {
    return { ok: false, response: new Response(`${field} must be a string`, { status: 400 }) };
  }
  return { ok: true, value: value.trim() };
}

async function parseDefaultWorkbenchId(
  db: ReturnType<typeof registryDb>,
  workspaceId: string,
  value: unknown,
): Promise<{ ok: true; value: string | null } | { ok: false; response: Response }> {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string" || !value.trim()) {
    return {
      ok: false,
      response: new Response("defaultWorkbenchId must be a string or null", { status: 400 }),
    };
  }

  const clean = value.trim();
  try {
    await new WorkbenchRepository(db).assertActiveWorkbenchInWorkspace(clean, workspaceId);
    return { ok: true, value: clean };
  } catch {
    return { ok: false, response: new Response("Not found", { status: 404 }) };
  }
}

function matchId(pathname: string, re: RegExp): string | null {
  const match = pathname.match(re);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}
