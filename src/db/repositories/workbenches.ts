import { and, asc, desc, eq, isNotNull, isNull } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type * as schema from "../schema";
import {
  agentRepositories,
  agentSecretNames,
  workbenches,
  type Workbench,
  type AgentRepositoryRow,
} from "../schema";
import type { ProjectStatus } from "./projects";

export type WorkbenchRepositoryEntry = {
  source: "github" | "url";
  name: string;
  url: string;
  githubRepoId?: number | null;
  sourceInstallationId?: string | null;
  checkoutPathName: string;
  defaultBranch: string;
  rootDirectory: string;
  setupCommand: string;
  packageManager: string;
};

export class WorkbenchRepository {
  constructor(private readonly db: DrizzleD1Database<typeof schema>) {}

  async create(input: typeof workbenches.$inferInsert): Promise<Workbench> {
    await this.db.insert(workbenches).values(input);
    const row = await this.getById(input.id);
    if (!row) throw new Error("workbench_not_found");
    return row;
  }

  async getById(id: string): Promise<Workbench | undefined> {
    return this.db.select().from(workbenches).where(eq(workbenches.id, id)).get();
  }

  async listForWorkspace(
    workspaceId: string,
    status: ProjectStatus = "active",
  ): Promise<Workbench[]> {
    const archiveFilter =
      status === "active"
        ? isNull(workbenches.archivedAt)
        : status === "archived"
          ? isNotNull(workbenches.archivedAt)
          : undefined;
    return this.db
      .select()
      .from(workbenches)
      .where(
        archiveFilter
          ? and(eq(workbenches.workspaceId, workspaceId), archiveFilter)
          : eq(workbenches.workspaceId, workspaceId),
      )
      .orderBy(status === "archived" ? desc(workbenches.archivedAt) : desc(workbenches.updatedAt))
      .all();
  }

  async update(
    id: string,
    patch: Partial<
      Pick<
        Workbench,
        | "name"
        | "description"
        | "setupScript"
        | "resourceProfile"
        | "sandboxEnvVarsJson"
        | "sandboxNetworkDomainAllowlist"
        | "updatedAt"
      >
    >,
  ): Promise<void> {
    await this.db.update(workbenches).set(patch).where(eq(workbenches.id, id));
  }

  async archive(id: string, archivedAt: number): Promise<void> {
    await this.db
      .update(workbenches)
      .set({ archivedAt })
      .where(and(eq(workbenches.id, id), isNull(workbenches.archivedAt)));
  }

  async assertActiveWorkbenchInWorkspace(
    workbenchId: string,
    workspaceId: string,
  ): Promise<Workbench> {
    const row = await this.db
      .select()
      .from(workbenches)
      .where(
        and(
          eq(workbenches.id, workbenchId),
          eq(workbenches.workspaceId, workspaceId),
          isNull(workbenches.archivedAt),
        ),
      )
      .get();
    if (!row) throw new Error("workbench_not_found");
    return row;
  }

  async replaceRepositories(
    workbenchId: string,
    workspaceId: string,
    entries: WorkbenchRepositoryEntry[],
    createdAt: number,
  ): Promise<void> {
    await this.assertActiveWorkbenchInWorkspace(workbenchId, workspaceId);
    const del = this.db.delete(agentRepositories).where(eq(agentRepositories.agentId, workbenchId));
    const statements: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]] = [del];
    if (entries.length > 0) {
      statements.push(
        this.db.insert(agentRepositories).values(
          entries.map((entry) => ({
            id: `wbr_${crypto.randomUUID()}`,
            agentId: workbenchId,
            source: entry.source,
            name: entry.name,
            url: entry.url,
            githubRepoId: entry.githubRepoId ?? null,
            sourceInstallationId: entry.sourceInstallationId ?? null,
            checkoutPathName: entry.checkoutPathName,
            defaultBranch: entry.defaultBranch,
            rootDirectory: entry.rootDirectory,
            setupCommand: entry.setupCommand,
            packageManager: entry.packageManager,
            createdAt,
          })),
        ),
      );
    }
    await this.db.batch(statements);
  }

  async listRepositories(workbenchId: string): Promise<AgentRepositoryRow[]> {
    return this.db
      .select()
      .from(agentRepositories)
      .where(eq(agentRepositories.agentId, workbenchId))
      .orderBy(asc(agentRepositories.id))
      .all();
  }

  /** Strongly-consistent secret names for a workbench, sorted by name. */
  async listSecretNames(workbenchId: string): Promise<string[]> {
    const rows = await this.db
      .select({ name: agentSecretNames.name })
      .from(agentSecretNames)
      .where(eq(agentSecretNames.agentId, workbenchId))
      .orderBy(asc(agentSecretNames.name))
      .all();
    return rows.map((row) => row.name);
  }

  async putSecretName(workbenchId: string, name: string, updatedAt: number): Promise<void> {
    await this.db
      .insert(agentSecretNames)
      .values({ agentId: workbenchId, name, updatedAt })
      .onConflictDoUpdate({
        target: [agentSecretNames.agentId, agentSecretNames.name],
        set: { updatedAt },
      });
  }

  async deleteSecretName(workbenchId: string, name: string): Promise<void> {
    await this.db
      .delete(agentSecretNames)
      .where(and(eq(agentSecretNames.agentId, workbenchId), eq(agentSecretNames.name, name)));
  }

  /**
   * Seed the D1 name index from the pre-existing KV secret names, once. Sets the
   * workbench's backfilled flag even when `entries` is empty, so a workbench
   * with no secrets isn't re-listed from KV on every read. Idempotent: names
   * already present are left as-is.
   */
  async backfillSecretNames(
    workbenchId: string,
    entries: Array<{ name: string; updatedAt: number }>,
  ): Promise<void> {
    const markBackfilled = this.db
      .update(workbenches)
      .set({ secretNamesBackfilled: true })
      .where(eq(workbenches.id, workbenchId));
    if (entries.length === 0) {
      await markBackfilled;
      return;
    }
    await this.db.batch([
      this.db
        .insert(agentSecretNames)
        .values(entries.map((entry) => ({ agentId: workbenchId, ...entry })))
        .onConflictDoNothing(),
      markBackfilled,
    ]);
  }
}
