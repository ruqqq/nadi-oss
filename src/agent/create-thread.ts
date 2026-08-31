import type { registryDb } from "../db/client";
import { threadIndex } from "../db/schema";
import { ThreadRepository } from "../db/repositories/threads";

/**
 * Assigning an environment to a thread is now a single column write: the
 * per-thread configuration snapshot it used to build alongside the row is
 * gone, so there is no second write to keep consistent and no transaction to
 * fall back from.
 */
export async function createThreadWithWorkbench(
  db: ReturnType<typeof registryDb>,
  thread: typeof threadIndex.$inferInsert,
  workbenchId: string | null,
): Promise<void> {
  await new ThreadRepository(db).createWithWorkbench(thread, workbenchId);
}
