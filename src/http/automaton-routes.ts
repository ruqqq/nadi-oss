import { asc, eq } from "drizzle-orm";
import { AutomatonRunFailedAfterClaim, startAutomatonRun } from "../automata/fire-due";
import {
  AutomatonService,
  AutomatonNotFoundError,
  AutomatonProjectNotFoundError,
  AutomatonValidationError,
} from "../automata/service";
import { validateRequestSession, type ValidatedSession } from "../auth/session";
import { registryDb } from "../db/client";
import { AutomatonRepository } from "../db/repositories/automata";
import { WorkspaceRepository } from "../db/repositories/workspaces";
import { agents, automata, workspaceMembers } from "../db/schema";
import type { Automaton } from "../db/schema";
import type { Env } from "../env";

/**
 * An automaton's environment is its AGENT now — the `workbench_id` column is
 * gone. The wire field keeps its old name here, and is renamed together with
 * `web/src/mocks/` in the task that owns the route surface.
 */
function serializeAutomaton(row: Automaton): Automaton & { workbenchId: string } {
  return { ...row, workbenchId: row.agentId };
}

const LIST_PATH = "/api/automata";
const ITEM_RE = /^\/api\/automata\/([^/]+)$/;
const RUN_RE = /^\/api\/automata\/([^/]+)\/run$/;

export async function routeAutomata(
  req: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === LIST_PATH) {
    if (req.method === "GET") return listAutomata(req, env);
    if (req.method === "POST") return createAutomaton(req, env);
    return new Response("Method not allowed", { status: 405 });
  }

  const runMatch = RUN_RE.exec(path);
  if (runMatch) {
    if (req.method === "POST") return runAutomatonNow(req, env, runMatch[1]!);
    return new Response("Method not allowed", { status: 405 });
  }

  const itemMatch = ITEM_RE.exec(path);
  if (itemMatch) {
    const id = itemMatch[1]!;
    if (req.method === "GET") return getAutomaton(req, env, id);
    if (req.method === "PATCH") return updateAutomaton(req, env, id);
    if (req.method === "DELETE") return archiveAutomaton(req, env, id);
    return new Response("Method not allowed", { status: 405 });
  }

  if (path.startsWith("/api/automata/")) {
    return new Response("Not found", { status: 404 });
  }

  return null;
}

function automatonErrorToResponse(error: unknown): Response {
  if (error instanceof AutomatonValidationError) {
    return Response.json({ error: error.message }, { status: 400 });
  }
  if (error instanceof AutomatonProjectNotFoundError) {
    return Response.json({ error: error.message }, { status: 404 });
  }
  if (error instanceof AutomatonNotFoundError) {
    return new Response("Not found", { status: 404 });
  }
  throw error;
}

async function listAutomata(req: Request, env: Env): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const target = await selectAutomatonTarget(env, session);
  if (!target) return Response.json({ automata: [] });

  const service = new AutomatonService(registryDb(env), {
    env,
    workspaceId: target.workspaceId,
    ownerUserId: session.user.id,
    agentId: target.agentId,
    viewerEmail: session.user.email ?? null,
  });
  return Response.json({ automata: (await service.list()).map(serializeAutomaton) });
}

async function createAutomaton(req: Request, env: Env): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const target = await selectAutomatonTarget(env, session);
  if (!target) return new Response("Workspace agent not found", { status: 404 });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return new Response("Invalid JSON body", { status: 400 });

  const service = new AutomatonService(registryDb(env), {
    env,
    workspaceId: target.workspaceId,
    ownerUserId: session.user.id,
    agentId: target.agentId,
    viewerEmail: session.user.email ?? null,
  });
  try {
    const automaton = await service.create({
      name: body.name,
      prompt: body.prompt,
      timezone: body.timezone,
      schedule: body.schedule,
      projectId: body.projectId,
      workbenchId: body.workbenchId,
      notifyMode: body.notifyMode,
      enabled: body.enabled,
      modelProvider: body.modelProvider,
      model: body.model,
      modelInputModalities: body.modelInputModalities,
    });
    return Response.json({ automaton: serializeAutomaton(automaton) }, { status: 201 });
  } catch (error) {
    return automatonErrorToResponse(error);
  }
}

async function getAutomaton(req: Request, env: Env, id: string): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const db = registryDb(env);
  const repo = new AutomatonRepository(db);
  const automaton = await repo.getById(id);
  if (!automaton || automaton.archivedAt !== null)
    return new Response("Not found", { status: 404 });

  try {
    await new WorkspaceRepository(db).assertMember({
      workspaceId: automaton.workspaceId,
      userId: session.user.id,
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }

  const runs = await repo.listRuns(id, 20);
  return Response.json({ automaton: serializeAutomaton(automaton), runs });
}

async function updateAutomaton(req: Request, env: Env, id: string): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const db = registryDb(env);
  const repo = new AutomatonRepository(db);
  const automaton = await repo.getById(id);
  if (!automaton || automaton.archivedAt !== null)
    return new Response("Not found", { status: 404 });

  try {
    await new WorkspaceRepository(db).assertMember({
      workspaceId: automaton.workspaceId,
      userId: session.user.id,
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return new Response("Invalid JSON body", { status: 400 });

  const service = new AutomatonService(db, {
    env,
    workspaceId: automaton.workspaceId,
    ownerUserId: session.user.id,
    agentId: automaton.agentId,
    viewerEmail: session.user.email ?? null,
  });
  try {
    const updated = await service.update(id, {
      name: body.name,
      prompt: body.prompt,
      timezone: body.timezone,
      schedule: body.schedule,
      projectId: body.projectId,
      workbenchId: body.workbenchId,
      notifyMode: body.notifyMode,
      enabled: body.enabled,
      modelProvider: body.modelProvider,
      model: body.model,
      modelInputModalities: body.modelInputModalities,
    });
    return Response.json({ automaton: serializeAutomaton(updated) });
  } catch (error) {
    return automatonErrorToResponse(error);
  }
}

async function archiveAutomaton(req: Request, env: Env, id: string): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const db = registryDb(env);
  const repo = new AutomatonRepository(db);
  const automaton = await repo.getById(id);
  if (!automaton || automaton.archivedAt !== null)
    return new Response("Not found", { status: 404 });

  try {
    await new WorkspaceRepository(db).assertMember({
      workspaceId: automaton.workspaceId,
      userId: session.user.id,
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }

  // Soft delete: automaton_runs holds an FK to automata, so a hard delete
  // would orphan run history.
  await db
    .update(automata)
    .set({ archivedAt: Date.now(), updatedAt: Date.now() })
    .where(eq(automata.id, id));

  const archived = await repo.getById(id);
  if (!archived) return new Response("Not found", { status: 404 });
  return Response.json({ automaton: serializeAutomaton(archived) });
}

async function runAutomatonNow(req: Request, env: Env, id: string): Promise<Response> {
  const session = await validateRequestSession(env, req);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const db = registryDb(env);
  const repo = new AutomatonRepository(db);
  const automaton = await repo.getById(id);
  if (!automaton || automaton.archivedAt !== null)
    return new Response("Not found", { status: 404 });

  try {
    await new WorkspaceRepository(db).assertMember({
      workspaceId: automaton.workspaceId,
      userId: session.user.id,
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }

  // Manual runs are fully independent: no dedupe key (dueAt is null, and the
  // unique index is partial on trigger='scheduled'), and no overlap check.
  try {
    const { runId, threadId } = await startAutomatonRun(env, db, automaton, {
      trigger: "manual",
      dueAt: null,
    });
    return Response.json({ runId, threadId }, { status: 202 });
  } catch (error) {
    if (error instanceof AutomatonRunFailedAfterClaim) {
      // The claim landed and the run row already records the real failure —
      // nothing to clean up here, just report it.
      return Response.json(
        { error: `Could not start the run: ${String(error.cause ?? error)}` },
        { status: 500 },
      );
    }
    throw error;
  }
}

/**
 * Mirrors `selectThreadTarget` in thread-routes.ts: the caller's first
 * workspace (by membership order) and that workspace's first agent.
 */
async function selectAutomatonTarget(
  env: Env,
  session: ValidatedSession,
): Promise<{ workspaceId: string; agentId: string } | null> {
  const db = registryDb(env);
  const row = await db
    .select({
      workspaceId: workspaceMembers.workspaceId,
      agentId: agents.id,
    })
    .from(workspaceMembers)
    .innerJoin(agents, eq(agents.workspaceId, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, session.user.id))
    .orderBy(asc(workspaceMembers.createdAt), asc(agents.createdAt))
    .get();
  return row ?? null;
}
