import { and, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type * as schema from "../schema";
import { mcpServers, mcpToolPolicies } from "../schema";
import { mcpServerId } from "../../mcp/tool-key";

export type ToolPolicy = "auto_allow" | "approval_required" | "deny";

export class McpServerRepository {
  constructor(private readonly db: DrizzleD1Database<typeof schema>) {}

  async list(workspaceId: string) {
    return this.db.select().from(mcpServers).where(eq(mcpServers.workspaceId, workspaceId)).all();
  }

  async getById(id: string) {
    return this.db.select().from(mcpServers).where(eq(mcpServers.id, id)).get();
  }

  async create(workspaceId: string, input: { name: string; url: string }) {
    const row = {
      id: mcpServerId(),
      workspaceId,
      name: input.name,
      url: input.url,
      enabled: true,
      createdAt: Date.now(),
    };
    await this.db.insert(mcpServers).values(row);
    return row;
  }

  async update(id: string, patch: { name?: string; enabled?: boolean }) {
    await this.db.update(mcpServers).set(patch).where(eq(mcpServers.id, id));
    return this.getById(id);
  }

  async delete(id: string) {
    // No DB-level cascade — remove the server's tool policies first.
    await this.db.delete(mcpToolPolicies).where(eq(mcpToolPolicies.serverId, id));
    await this.db.delete(mcpServers).where(eq(mcpServers.id, id));
  }

  async listPolicies(serverId: string) {
    return this.db
      .select()
      .from(mcpToolPolicies)
      .where(eq(mcpToolPolicies.serverId, serverId))
      .all();
  }

  async setPolicies(
    workspaceId: string,
    serverId: string,
    policies: Array<{ toolName: string; policy: ToolPolicy }>,
  ) {
    const ts = Date.now();
    for (const { toolName, policy } of policies) {
      await this.db
        .delete(mcpToolPolicies)
        .where(and(eq(mcpToolPolicies.serverId, serverId), eq(mcpToolPolicies.toolName, toolName)));
      await this.db.insert(mcpToolPolicies).values({
        id: `pol_${crypto.randomUUID()}`,
        workspaceId,
        serverId,
        toolName,
        policy,
        createdAt: ts,
        updatedAt: ts,
      });
    }
    return this.listPolicies(serverId);
  }
}
