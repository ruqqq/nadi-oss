import { validateRequestSession } from "../auth/session";
import { registryDb } from "../db/client";
import { ThreadRepository } from "../db/repositories/threads";
import { WorkspaceRepository } from "../db/repositories/workspaces";
import { assertFeedbackReporter } from "../feedback/access";
import type { Env } from "../env";
import { parseThreadAgentPath } from "./agent-path";

export type AgentAuthorizationResult =
  | { authorized: true; threadId: string; userId: string; workspaceId: string }
  | { authorized: false; response: Response };

export async function authorizeAgentRequest(
  req: Request,
  env: Env,
): Promise<AgentAuthorizationResult> {
  const parsed = parseThreadAgentPath(new URL(req.url));
  if (!parsed) {
    return { authorized: false, response: new Response("Not found", { status: 404 }) };
  }

  const session = await validateRequestSession(env, req);
  if (!session) {
    return { authorized: false, response: new Response("Unauthorized", { status: 401 }) };
  }

  const db = registryDb(env);
  const thread = await new ThreadRepository(db).getById(parsed.threadId);
  if (!thread) {
    return { authorized: false, response: new Response("Not found", { status: 404 }) };
  }

  if (thread.kind === "feedback") {
    const scope = await assertFeedbackReporter(env, parsed.threadId, session.user.id);
    if (!scope) {
      return { authorized: false, response: new Response("Not found", { status: 404 }) };
    }
    return {
      authorized: true,
      threadId: parsed.threadId,
      userId: session.user.id,
      workspaceId: scope.workspaceId,
    };
  }

  try {
    await new WorkspaceRepository(db).assertMember({
      workspaceId: thread.workspaceId,
      userId: session.user.id,
    });
  } catch {
    return { authorized: false, response: new Response("Not found", { status: 404 }) };
  }

  const url = new URL(req.url);
  const isHistoryFetch = req.method === "GET" && url.pathname.endsWith("/get-messages");
  const isWebSocket = req.headers.get("upgrade")?.toLowerCase() === "websocket";
  if (thread.archivedAt != null && (isWebSocket || !isHistoryFetch)) {
    return {
      authorized: false,
      response: new Response("Archived threads are read-only", { status: 410 }),
    };
  }

  return {
    authorized: true,
    threadId: parsed.threadId,
    userId: session.user.id,
    workspaceId: thread.workspaceId,
  };
}
