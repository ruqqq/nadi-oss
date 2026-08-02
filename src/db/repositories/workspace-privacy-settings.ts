import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type * as schema from "../schema";
import { workspacePrivacySettings } from "../schema";

type WorkspacePrivacySettingsRepositoryDb = DrizzleD1Database<typeof schema>;

export interface WorkspacePrivacySettingsView {
  telemetryEnabled: boolean;
}

export class WorkspacePrivacySettingsRepository {
  constructor(private readonly db: WorkspacePrivacySettingsRepositoryDb) {}

  async get(workspaceId: string): Promise<WorkspacePrivacySettingsView> {
    const row = await this.db
      .select()
      .from(workspacePrivacySettings)
      .where(eq(workspacePrivacySettings.workspaceId, workspaceId))
      .get();
    return { telemetryEnabled: row?.telemetryEnabled ?? false };
  }

  async setTelemetryEnabled(input: {
    workspaceId: string;
    enabled: boolean;
    now: number;
  }): Promise<WorkspacePrivacySettingsView> {
    await this.db
      .insert(workspacePrivacySettings)
      .values({
        workspaceId: input.workspaceId,
        telemetryEnabled: input.enabled,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoUpdate({
        target: workspacePrivacySettings.workspaceId,
        set: {
          telemetryEnabled: input.enabled,
          updatedAt: input.now,
        },
      });
    return { telemetryEnabled: input.enabled };
  }
}
