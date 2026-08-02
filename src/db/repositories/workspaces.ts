import { and, asc, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type * as schema from "../schema";
import { agents, users, workspaceMembers, workspaceSandboxSettings, workspaces } from "../schema";

export class WorkspaceRepository {
  constructor(private readonly db: DrizzleD1Database<typeof schema>) {}

  async assertMember(input: { workspaceId: string; userId: string }) {
    const row = await this.db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, input.workspaceId),
          eq(workspaceMembers.userId, input.userId),
        ),
      )
      .get();
    if (!row) throw new Error("workspace_not_found");
    return row;
  }

  async get(workspaceId: string) {
    return this.db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).get();
  }

  async getCurrentWorkspaceForOwner(userId: string) {
    return this.db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        createdAt: workspaces.createdAt,
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
      .where(and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.role, "owner")))
      .orderBy(asc(workspaceMembers.createdAt))
      .get();
  }

  /**
   * Ensure the user owns a workspace, creating one (plus an owner membership and
   * a default agent) if they don't. Idempotent: if the user already owns a
   * workspace, that existing workspace is returned and nothing is created. Used
   * to provision a private workspace for a brand-new user on first sign-in.
   *
   * The default agent is seeded so the workspace is immediately valid: settings
   * routes and chat both require a default agent to resolve provider/model.
   * Onboarding later overwrites its provider/model/instructions.
   */
  async provisionForOwner(input: {
    userId: string;
    name?: string;
    now: number;
    defaultAgent: { name: string; systemPrompt: string; provider: string; model: string };
    /**
     * Optional compute default for the new workspace. When provided, a
     * `workspace_sandbox_settings` row is seeded so the workspace has a compute
     * provider without visiting settings. Omit to leave compute unconfigured
     * (the legacy behavior: no row, compute disabled). Policy lives in the
     * caller (it holds `env` and knows which provider the deployment supports);
     * this repository only writes what it is given.
     */
    defaultSandbox?: {
      provider: string;
      enabled: boolean;
      providerConfigJson: string;
    };
  }) {
    const existing = await this.getCurrentWorkspaceForOwner(input.userId);
    if (existing) {
      return existing;
    }

    const workspace = {
      id: `ws_${crypto.randomUUID()}`,
      name: input.name ?? "Personal workspace",
      createdAt: input.now,
    };
    await this.db.insert(workspaces).values(workspace);
    await this.db.insert(workspaceMembers).values({
      workspaceId: workspace.id,
      userId: input.userId,
      role: "owner",
      createdAt: input.now,
    });
    await this.db.insert(agents).values({
      id: `agt_${crypto.randomUUID()}`,
      workspaceId: workspace.id,
      name: input.defaultAgent.name,
      systemPrompt: input.defaultAgent.systemPrompt,
      provider: input.defaultAgent.provider,
      model: input.defaultAgent.model,
      createdAt: input.now,
    });
    if (input.defaultSandbox) {
      await this.db
        .insert(workspaceSandboxSettings)
        .values({
          workspaceId: workspace.id,
          enabled: input.defaultSandbox.enabled,
          provider: input.defaultSandbox.provider,
          providerConfigJson: input.defaultSandbox.providerConfigJson,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .onConflictDoNothing();
    }
    return workspace;
  }

  /** The user id of the workspace's owner membership, or null if none. */
  async getOwnerUserId(workspaceId: string): Promise<string | null> {
    const row = await this.db
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, "owner")))
      .orderBy(asc(workspaceMembers.createdAt))
      .get();
    return row?.userId ?? null;
  }

  /** Whether userId currently holds the "owner" role on workspaceId. */
  async isOwner(workspaceId: string, userId: string): Promise<boolean> {
    const row = await this.db
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, userId),
          eq(workspaceMembers.role, "owner"),
        ),
      )
      .get();
    return row !== undefined;
  }

  /** The email of the workspace's owner membership, or null if none. */
  async getOwnerEmail(workspaceId: string): Promise<string | null> {
    const row = await this.db
      .select({ email: users.email })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, "owner")))
      .orderBy(asc(workspaceMembers.createdAt))
      .get();
    return row?.email ?? null;
  }
}
