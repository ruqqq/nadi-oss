import { and, asc, eq, isNull } from "drizzle-orm";
import type { Env } from "../env";
import type { ValidatedSession } from "../auth/session";
import { registryDb } from "../db/client";
import { agents, workspaceMembers } from "../db/schema";

/**
 * Resolve the caller's workspace + an agent to scope an un-targeted request to.
 *
 * Multi-agent HAS landed: a workspace really does hold several agents now, and
 * the surfaces that address ONE of them take an explicit id (see
 * {@link resolveAgentScopeById}). This is the fallback for the requests that
 * name none — `/api/memories` with no `agentId`, `/api/skills`, the workspace
 * lookups — so it takes the earliest membership joined to the earliest agent
 * that is USABLE, exactly as `selectThreadTarget` does in thread-routes.
 *
 * Archived and disabled agents are excluded HERE, at the data source: without
 * it, deleting an agent would leave `/api/memories` resolving onto the deleted
 * agent's memories, and a stale id would keep being handed out after the row
 * stopped being available for work. The last-agent guard on archive and disable
 * (`AgentRepository.countUsableExcluding`) is what guarantees a row still
 * matches. Multi-WORKSPACE has not landed; that part still takes the earliest.
 */
export async function resolveAgentScope(
  env: Env,
  session: ValidatedSession,
): Promise<{ workspaceId: string; agentId: string } | null> {
  const row = await registryDb(env)
    .select({ workspaceId: workspaceMembers.workspaceId, agentId: agents.id })
    .from(workspaceMembers)
    .innerJoin(agents, eq(agents.workspaceId, workspaceMembers.workspaceId))
    .where(
      and(
        eq(workspaceMembers.userId, session.user.id),
        isNull(agents.archivedAt),
        eq(agents.enabled, true),
      ),
    )
    // The id tie-break matches `selectThreadTarget`: without it two agents
    // created in the same millisecond make "the workspace's agent" a coin flip.
    .orderBy(asc(workspaceMembers.createdAt), asc(agents.createdAt), asc(agents.id))
    .get();
  return row ?? null;
}

/**
 * The same scope, but for an EXPLICITLY named agent — the drill-down surfaces
 * (`/settings/agents/:id`) address one agent, not "the workspace's earliest".
 * Returns null when the agent does not exist or the caller is not a member of
 * its workspace, so a caller cannot distinguish the two.
 */
export async function resolveAgentScopeById(
  env: Env,
  session: ValidatedSession,
  agentId: string,
): Promise<{ workspaceId: string; agentId: string } | null> {
  const row = await registryDb(env)
    .select({ workspaceId: agents.workspaceId })
    .from(agents)
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, agents.workspaceId),
        eq(workspaceMembers.userId, session.user.id),
      ),
    )
    .where(eq(agents.id, agentId))
    .get();
  return row ? { workspaceId: row.workspaceId, agentId } : null;
}
