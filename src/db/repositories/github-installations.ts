import { and, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type * as schema from "../schema";
import { githubAppInstallations, type GithubAppInstallationRow } from "../schema";

export type GithubInstallationStatus = "active" | "disconnected" | "suspended";

export interface GithubAppInstallationInsert {
  workspaceId: string;
  installationId: number;
  accountLogin: string;
  accountType: "org" | "user";
  repositorySelection: "all" | "selected";
  connectedByUserId: string;
}

export class GithubInstallationRepository {
  constructor(private readonly db: DrizzleD1Database<typeof schema>) {}

  async upsert(input: GithubAppInstallationInsert): Promise<GithubAppInstallationRow> {
    const now = Date.now();
    const set = {
      accountLogin: input.accountLogin,
      accountType: input.accountType,
      repositorySelection: input.repositorySelection,
      connectedByUserId: input.connectedByUserId,
      status: "active" as const,
      updatedAt: now,
    };
    await this.db
      .insert(githubAppInstallations)
      .values({ id: `ghi_${crypto.randomUUID()}`, ...input, ...set, createdAt: now })
      .onConflictDoUpdate({
        target: [githubAppInstallations.workspaceId, githubAppInstallations.installationId],
        set,
      });
    const row = await this.db
      .select()
      .from(githubAppInstallations)
      .where(
        and(
          eq(githubAppInstallations.workspaceId, input.workspaceId),
          eq(githubAppInstallations.installationId, input.installationId),
        ),
      )
      .get();
    if (!row) throw new Error("github_installation_upsert_failed");
    return row;
  }

  async listForWorkspace(workspaceId: string): Promise<GithubAppInstallationRow[]> {
    return this.db
      .select()
      .from(githubAppInstallations)
      .where(eq(githubAppInstallations.workspaceId, workspaceId))
      .all();
  }

  async getActiveByOwner(
    workspaceId: string,
    ownerLogin: string,
  ): Promise<GithubAppInstallationRow | undefined> {
    return this.db
      .select()
      .from(githubAppInstallations)
      .where(
        and(
          eq(githubAppInstallations.workspaceId, workspaceId),
          eq(githubAppInstallations.accountLogin, ownerLogin),
          eq(githubAppInstallations.status, "active"),
        ),
      )
      .get();
  }

  async markStatus(
    workspaceId: string,
    installationId: number,
    status: GithubInstallationStatus,
  ): Promise<void> {
    await this.db
      .update(githubAppInstallations)
      .set({ status, updatedAt: Date.now() })
      .where(
        and(
          eq(githubAppInstallations.workspaceId, workspaceId),
          eq(githubAppInstallations.installationId, installationId),
        ),
      );
  }
}
