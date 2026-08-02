import { eq } from "drizzle-orm";
import { registryDb } from "../db/client";
import { workspaceMembers } from "../db/schema";
import { fanOutToUsers } from "./fan-out";
import type { Env } from "../env";
import type { UserEvent } from "./user-events";

/**
 * Fan an event out to every member of a workspace's UserHub. Best-effort: any
 * failure (DB or DO) is swallowed so a live-update miss never fails the user's
 * underlying action.
 */
export async function notifyWorkspaceMembers(
  env: Env,
  workspaceId: string,
  event: UserEvent,
): Promise<void> {
  try {
    const db = registryDb(env);
    const rows = await db
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspaceId))
      .all();
    await fanOutToUsers(
      env.USER_HUB,
      rows.map((r) => r.userId),
      event,
    );
  } catch {
    // Best-effort: live updates must never fail the user's action.
  }
}
