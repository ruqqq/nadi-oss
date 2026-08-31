import { and, asc, desc, eq, isNotNull, isNull } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type * as schema from "../schema";
import {
  agentRepositories,
  agents,
  agentSecretNames,
  type AgentConfig,
  type AgentRepositoryRow,
} from "../schema";
import type { ProjectStatus } from "./projects";

export type AgentRepositoryEntry = {
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

/**
 * The sandbox configuration an AGENT carries — setup script, repositories,
 * secrets, env vars, resource profile, network allowlist.
 */
export class AgentRepository {
  constructor(private readonly db: DrizzleD1Database<typeof schema>) {}

  async create(input: typeof agents.$inferInsert): Promise<AgentConfig> {
    await this.db.insert(agents).values(input);
    const row = await this.getById(input.id);
    if (!row) throw new Error("agent_not_found");
    return row;
  }

  async getById(id: string): Promise<AgentConfig | undefined> {
    return this.db.select().from(agents).where(eq(agents.id, id)).get();
  }

  async listForWorkspace(
    workspaceId: string,
    status: ProjectStatus = "active",
  ): Promise<AgentConfig[]> {
    const archiveFilter =
      status === "active"
        ? isNull(agents.archivedAt)
        : status === "archived"
          ? isNotNull(agents.archivedAt)
          : undefined;
    return this.db
      .select()
      .from(agents)
      .where(
        archiveFilter
          ? and(eq(agents.workspaceId, workspaceId), archiveFilter)
          : eq(agents.workspaceId, workspaceId),
      )
      .orderBy(status === "archived" ? desc(agents.archivedAt) : desc(agents.updatedAt))
      .all();
  }

  async update(
    id: string,
    patch: Partial<
      Pick<
        AgentConfig,
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
    await this.db.update(agents).set(patch).where(eq(agents.id, id));
  }

  async archive(id: string, archivedAt: number): Promise<void> {
    await this.db
      .update(agents)
      .set({ archivedAt })
      .where(and(eq(agents.id, id), isNull(agents.archivedAt)));
  }

  async assertActiveAgentInWorkspace(agentId: string, workspaceId: string): Promise<AgentConfig> {
    const row = await this.db
      .select()
      .from(agents)
      .where(
        and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId), isNull(agents.archivedAt)),
      )
      .get();
    if (!row) throw new Error("agent_not_found");
    return row;
  }

  async replaceRepositories(
    agentId: string,
    workspaceId: string,
    entries: AgentRepositoryEntry[],
    createdAt: number,
  ): Promise<void> {
    await this.assertActiveAgentInWorkspace(agentId, workspaceId);
    const del = this.db.delete(agentRepositories).where(eq(agentRepositories.agentId, agentId));
    const statements: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]] = [del];
    if (entries.length > 0) {
      statements.push(
        this.db.insert(agentRepositories).values(
          entries.map((entry) => ({
            id: `wbr_${crypto.randomUUID()}`,
            agentId,
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

  async listRepositories(agentId: string): Promise<AgentRepositoryRow[]> {
    return this.db
      .select()
      .from(agentRepositories)
      .where(eq(agentRepositories.agentId, agentId))
      .orderBy(asc(agentRepositories.id))
      .all();
  }

  /** Strongly-consistent secret names for an agent, sorted by name. */
  async listSecretNames(agentId: string): Promise<string[]> {
    const rows = await this.db
      .select({ name: agentSecretNames.name })
      .from(agentSecretNames)
      .where(eq(agentSecretNames.agentId, agentId))
      .orderBy(asc(agentSecretNames.name))
      .all();
    return rows.map((row) => row.name);
  }

  async putSecretName(agentId: string, name: string, updatedAt: number): Promise<void> {
    await this.db
      .insert(agentSecretNames)
      .values({ agentId, name, updatedAt })
      .onConflictDoUpdate({
        target: [agentSecretNames.agentId, agentSecretNames.name],
        set: { updatedAt },
      });
  }

  async deleteSecretName(agentId: string, name: string): Promise<void> {
    await this.db
      .delete(agentSecretNames)
      .where(and(eq(agentSecretNames.agentId, agentId), eq(agentSecretNames.name, name)));
  }

  /**
   * Seed the D1 name index from the pre-existing KV secret names, once. Sets the
   * agent's backfilled flag even when `entries` is empty, so an agent with no
   * secrets isn't re-listed from KV on every read. Idempotent: names already
   * present are left as-is.
   *
   * The workbench migration deliberately leaves the flag FALSE on every row it
   * touched: it is SQL and cannot see KV, so a secret written under the agent
   * namespace by the sandbox settings surface has no D1 row yet. This is the
   * one-time reconciliation that picks those up.
   */
  async backfillSecretNames(
    agentId: string,
    entries: Array<{ name: string; updatedAt: number }>,
  ): Promise<void> {
    const markBackfilled = this.db
      .update(agents)
      .set({ secretNamesBackfilled: true })
      .where(eq(agents.id, agentId));
    if (entries.length === 0) {
      await markBackfilled;
      return;
    }
    await this.db.batch([
      this.db
        .insert(agentSecretNames)
        .values(entries.map((entry) => ({ agentId, ...entry })))
        .onConflictDoNothing(),
      markBackfilled,
    ]);
  }
}
