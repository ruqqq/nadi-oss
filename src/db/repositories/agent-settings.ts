import { and, asc, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type * as schema from "../schema";
import { agents } from "../schema";

export type AgentSelector = { kind: "default" } | { kind: "id"; agentId: string };

export interface AgentSettingsPatch {
  systemPrompt?: string;
  provider?: string;
  model?: string;
  modelInputModalities?: string;
  reasoningEffort?: string;
  modelSupportsReasoning?: boolean | null;
  sandboxEnabled?: boolean | null;
  sandboxIdleTimeoutMs?: number | null;
  sandboxMaxProcessRuntimeMs?: number | null;
}

type AgentSettingsUpdate = Partial<Pick<typeof agents.$inferInsert, keyof AgentSettingsPatch>>;

export class AgentSettingsRepository {
  constructor(private readonly db: DrizzleD1Database<typeof schema>) {}

  async getAgentSettings(workspaceId: string, selector: AgentSelector) {
    if (selector.kind === "id") {
      return this.db
        .select()
        .from(agents)
        .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, selector.agentId)))
        .get();
    }

    return this.db
      .select()
      .from(agents)
      .where(eq(agents.workspaceId, workspaceId))
      .orderBy(asc(agents.createdAt))
      .get();
  }

  async updateAgentSettings(
    workspaceId: string,
    selector: AgentSelector,
    patch: AgentSettingsPatch,
  ) {
    const target = await this.getAgentSettings(workspaceId, selector);
    if (!target) return undefined;

    const update: AgentSettingsUpdate = {};
    if (patch.systemPrompt !== undefined) update.systemPrompt = patch.systemPrompt;
    if (patch.provider !== undefined) update.provider = patch.provider;
    if (patch.model !== undefined) update.model = patch.model;
    if (patch.modelInputModalities !== undefined) {
      update.modelInputModalities = patch.modelInputModalities;
    }
    if (patch.reasoningEffort !== undefined) update.reasoningEffort = patch.reasoningEffort;
    if (patch.modelSupportsReasoning !== undefined) {
      update.modelSupportsReasoning = patch.modelSupportsReasoning;
    }
    if (patch.sandboxEnabled !== undefined) update.sandboxEnabled = patch.sandboxEnabled;
    if (patch.sandboxIdleTimeoutMs !== undefined) {
      update.sandboxIdleTimeoutMs = patch.sandboxIdleTimeoutMs;
    }
    if (patch.sandboxMaxProcessRuntimeMs !== undefined) {
      update.sandboxMaxProcessRuntimeMs = patch.sandboxMaxProcessRuntimeMs;
    }

    if (Object.keys(update).length === 0) return target;

    await this.db
      .update(agents)
      .set(update)
      .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, target.id)));

    return this.getAgentSettings(workspaceId, { kind: "id", agentId: target.id });
  }
}
