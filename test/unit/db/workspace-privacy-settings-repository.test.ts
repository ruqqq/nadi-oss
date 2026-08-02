import { beforeEach, describe, expect, it, vi } from "vitest";

const now = 1_800_000_000_000;

const workspacePrivacySettings = {
  __table: "workspace_privacy_settings",
  workspaceId: "workspaceId",
};

vi.mock("drizzle-orm", () => ({
  eq: (column: string, value: unknown) => (row: Record<string, unknown>) => row[column] === value,
}));

vi.mock("../../../src/db/schema", () => ({
  workspacePrivacySettings,
}));

interface WorkspacePrivacySettingsRow {
  workspaceId: string;
  telemetryEnabled: boolean;
  createdAt: number;
  updatedAt: number;
}

type Condition = (row: WorkspacePrivacySettingsRow) => boolean;

class WorkspacePrivacySettingsRepositoryTestDb {
  rows = new Map<string, WorkspacePrivacySettingsRow>();

  select() {
    return {
      from: (_table: { __table: string }) => ({
        where: (condition: Condition) => ({
          get: async () => [...this.rows.values()].filter((row) => condition(row))[0],
        }),
      }),
    };
  }

  insert(table: { __table: string }) {
    return {
      values: (row: WorkspacePrivacySettingsRow) => ({
        onConflictDoUpdate: async (input: { set: Partial<WorkspacePrivacySettingsRow> }) => {
          if (table.__table !== "workspace_privacy_settings") return;
          const current = this.rows.get(row.workspaceId);
          const next = { ...current, ...row, ...input.set } as WorkspacePrivacySettingsRow;
          this.rows.set(next.workspaceId, next);
        },
      }),
    };
  }
}

describe("WorkspacePrivacySettingsRepository", () => {
  let db: WorkspacePrivacySettingsRepositoryTestDb;
  let WorkspacePrivacySettingsRepository: typeof import("../../../src/db/repositories/workspace-privacy-settings").WorkspacePrivacySettingsRepository;

  beforeEach(async () => {
    vi.resetModules();
    ({ WorkspacePrivacySettingsRepository } =
      await import("../../../src/db/repositories/workspace-privacy-settings"));
    db = new WorkspacePrivacySettingsRepositoryTestDb();
  });

  it("returns telemetry disabled when no row exists", async () => {
    const repo = new WorkspacePrivacySettingsRepository(db as never);

    await expect(repo.get("ws1")).resolves.toEqual({ telemetryEnabled: false });
  });

  it("upserts telemetry preference values", async () => {
    const repo = new WorkspacePrivacySettingsRepository(db as never);

    await expect(
      repo.setTelemetryEnabled({ workspaceId: "ws1", enabled: true, now }),
    ).resolves.toEqual({ telemetryEnabled: true });
    await expect(repo.get("ws1")).resolves.toEqual({ telemetryEnabled: true });

    await expect(
      repo.setTelemetryEnabled({ workspaceId: "ws1", enabled: false, now: now + 1 }),
    ).resolves.toEqual({ telemetryEnabled: false });
    await expect(repo.get("ws1")).resolves.toEqual({ telemetryEnabled: false });
  });
});
