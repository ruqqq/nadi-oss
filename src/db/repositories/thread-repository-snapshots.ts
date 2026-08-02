import { and, asc, eq, inArray } from "drizzle-orm";
import type { D1Transaction, DrizzleD1Database } from "drizzle-orm/d1";
import type * as schema from "../schema";
import {
  threadRepositorySnapshots,
  threadWorkbenchSnapshots,
  workbenchRepositories,
  workbenches,
  type ThreadRepositorySnapshot,
  type ThreadWorkbenchSnapshot,
  type Workbench,
} from "../schema";

type ThreadRepositorySnapshotDb =
  | DrizzleD1Database<typeof schema>
  | D1Transaction<typeof schema, any>;
type ThreadRepositorySnapshotInsert = typeof threadRepositorySnapshots.$inferInsert;

export class ThreadRepositorySnapshotRepository {
  constructor(private readonly db: ThreadRepositorySnapshotDb) {}

  async replaceFromWorkbench(
    threadId: string,
    workspaceId: string,
    workbenchId: string | null,
    createdAt: number,
  ): Promise<void> {
    if (workbenchId === null) {
      await this.replaceForThread(threadId, []);
      await this.clearWorkbenchSnapshot(threadId);
      return;
    }

    const workbench = await this.assertWorkbenchInWorkspace(workbenchId, workspaceId);
    const snapshots = await this.buildFromWorkbench(threadId, workspaceId, workbenchId, createdAt);

    await this.replaceForThread(threadId, snapshots);
    await this.writeWorkbenchSnapshot(
      threadId,
      workspaceId,
      workbenchId,
      workbench.name,
      workbench.setupScript,
      createdAt,
      workbench.resourceProfile,
    );
  }

  async buildFromWorkbench(
    threadId: string,
    workspaceId: string,
    workbenchId: string,
    createdAt: number,
  ): Promise<ThreadRepositorySnapshotInsert[]> {
    await this.assertWorkbenchInWorkspace(workbenchId, workspaceId);

    const assignedRepositories = await this.db
      .select({
        id: workbenchRepositories.id,
        name: workbenchRepositories.name,
        url: workbenchRepositories.url,
        defaultBranch: workbenchRepositories.defaultBranch,
        checkoutPathName: workbenchRepositories.checkoutPathName,
        rootDirectory: workbenchRepositories.rootDirectory,
        setupCommand: workbenchRepositories.setupCommand,
        packageManager: workbenchRepositories.packageManager,
      })
      .from(workbenchRepositories)
      .where(eq(workbenchRepositories.workbenchId, workbenchId))
      .orderBy(asc(workbenchRepositories.id))
      .all();

    return assignedRepositories.map((repository) => ({
      id: `${threadId}:${repository.id}`,
      threadId,
      workspaceId,
      projectId: null,
      workbenchId,
      name: repository.name,
      url: repository.url,
      defaultBranch: repository.defaultBranch,
      checkoutPathName: repository.checkoutPathName,
      rootDirectory: repository.rootDirectory,
      setupCommand: repository.setupCommand,
      packageManager: repository.packageManager,
      createdAt,
    }));
  }

  async replaceForThread(
    threadId: string,
    snapshots: ThreadRepositorySnapshotInsert[],
  ): Promise<void> {
    await this.clearForThread(threadId);

    await this.insertForThread(snapshots);
  }

  async insertForThread(snapshots: ThreadRepositorySnapshotInsert[]): Promise<void> {
    if (snapshots.length === 0) {
      return;
    }

    await this.db.insert(threadRepositorySnapshots).values(snapshots);
  }

  async clearForThread(threadId: string): Promise<void> {
    await this.db
      .delete(threadRepositorySnapshots)
      .where(eq(threadRepositorySnapshots.threadId, threadId));
  }

  async listForThread(threadId: string): Promise<ThreadRepositorySnapshot[]> {
    return this.db
      .select()
      .from(threadRepositorySnapshots)
      .where(eq(threadRepositorySnapshots.threadId, threadId))
      .orderBy(asc(threadRepositorySnapshots.id))
      .all();
  }

  async listWorkbenchSnapshot(threadId: string): Promise<ThreadWorkbenchSnapshot | undefined> {
    return this.db
      .select()
      .from(threadWorkbenchSnapshots)
      .where(eq(threadWorkbenchSnapshots.threadId, threadId))
      .get();
  }

  async countForThreads(threadIds: string[]): Promise<Map<string, number>> {
    const counts = new Map(threadIds.map((threadId) => [threadId, 0]));
    if (threadIds.length === 0) {
      return counts;
    }

    const rows = await this.db
      .select({ threadId: threadRepositorySnapshots.threadId })
      .from(threadRepositorySnapshots)
      .where(inArray(threadRepositorySnapshots.threadId, threadIds))
      .all();

    for (const row of rows) {
      counts.set(row.threadId, (counts.get(row.threadId) ?? 0) + 1);
    }

    return counts;
  }

  private async writeWorkbenchSnapshot(
    threadId: string,
    workspaceId: string,
    workbenchId: string,
    name: string,
    setupScript: string,
    createdAt: number,
    resourceProfile: string,
  ): Promise<void> {
    await this.clearWorkbenchSnapshot(threadId);
    await this.db.insert(threadWorkbenchSnapshots).values({
      threadId,
      workspaceId,
      workbenchId,
      name,
      setupScript,
      resourceProfile,
      createdAt,
    });
  }

  async clearWorkbenchSnapshot(threadId: string): Promise<void> {
    await this.db
      .delete(threadWorkbenchSnapshots)
      .where(eq(threadWorkbenchSnapshots.threadId, threadId));
  }

  private async assertWorkbenchInWorkspace(
    workbenchId: string,
    workspaceId: string,
  ): Promise<Workbench> {
    const row = await this.db
      .select()
      .from(workbenches)
      .where(and(eq(workbenches.id, workbenchId), eq(workbenches.workspaceId, workspaceId)))
      .get();

    if (!row) {
      throw new Error("workbench_not_found");
    }

    return row;
  }
}
