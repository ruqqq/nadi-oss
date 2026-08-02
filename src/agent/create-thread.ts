import type { registryDb } from "../db/client";
import { threadIndex } from "../db/schema";
import { ThreadRepository } from "../db/repositories/threads";
import { ThreadRepositorySnapshotRepository } from "../db/repositories/thread-repository-snapshots";

export async function createThreadWithWorkbench(
  db: ReturnType<typeof registryDb>,
  thread: typeof threadIndex.$inferInsert,
  workbenchId: string | null,
): Promise<void> {
  const repo = new ThreadRepository(db);
  try {
    await repo.createWithWorkbench(thread, workbenchId);
    return;
  } catch (error) {
    if (!isUnsupportedD1TransactionStartError(error) || workbenchId === null) {
      throw error;
    }
  }

  const snapshots = new ThreadRepositorySnapshotRepository(db);
  await repo.create({ ...thread, workbenchId });
  try {
    await snapshots.replaceFromWorkbench(
      thread.id,
      thread.workspaceId,
      workbenchId,
      thread.createdAt,
    );
  } catch (error) {
    await repo.delete(thread.id);
    throw error;
  }
}

function isUnsupportedD1TransactionStartError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.message.includes("Failed query: begin") ||
    error.message.includes("please use the state.storage.transaction()") ||
    error.message.includes("SQL BEGIN TRANSACTION")
  );
}
