import type { registryDb } from "../db/client";
import { threadIndex } from "../db/schema";
import { ThreadRepository } from "../db/repositories/threads";

/**
 * Assigning a thread its environment is now a single column write, and the
 * column is `agent_id` itself: the agent carries the repositories, setup
 * script, secrets and env vars. No second write to keep consistent, and no
 * transaction to fall back from.
 *
 * `agentId` overrides whatever `thread.agentId` holds and is REQUIRED — the
 * resolved agent and the stored agent must not be able to disagree.
 */
export async function createThreadWithAgent(
  db: ReturnType<typeof registryDb>,
  thread: typeof threadIndex.$inferInsert,
  agentId: string,
): Promise<void> {
  await new ThreadRepository(db).createWithAgent(thread, agentId);
}
