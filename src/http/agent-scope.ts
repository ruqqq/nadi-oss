import { and, asc, eq } from "drizzle-orm";
import type { Env } from "../env";
import type { ValidatedSession } from "../auth/session";
import { registryDb } from "../db/client";
import { agents, workspaceMembers } from "../db/schema";

/**
 * Resolve the caller's workspace + configured agent. Nadi is single-workspace,
 * single-agent per user today, so we take the earliest membership joined to the
 * earliest agent — the same selection `selectThreadTarget` uses in thread-routes.
 * Revisit when multi-agent/multi-workspace lands (callers will then specify a target).
 */
export async function resolveAgentScope(
  env: Env,
  session: ValidatedSession,
): Promise<{ workspaceId: string; agentId: string } | null> {
  const row = await registryDb(env)
    .select({ workspaceId: workspaceMembers.workspaceId, agentId: agents.id })
    .from(workspaceMembers)
    .innerJoin(agents, eq(agents.workspaceId, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, session.user.id))
    .orderBy(asc(workspaceMembers.createdAt), asc(agents.createdAt))
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
