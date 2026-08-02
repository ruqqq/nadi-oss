import { beforeEach, describe, expect, it, vi } from "vitest";

const userVoiceSettings = {
  __table: "user_voice_settings",
  userId: "userId",
};

vi.mock("drizzle-orm", () => ({
  eq: (column: string, value: unknown) => (row: Record<string, unknown>) => row[column] === value,
}));

vi.mock("../../src/db/schema", () => ({
  userVoiceSettings,
}));

interface VoiceSettingsRow {
  userId: string;
  language: string;
  createdAt: number;
  updatedAt: number;
}

type Condition = (row: VoiceSettingsRow) => boolean;

class VoiceRepositoryTestDb {
  rows = new Map<string, VoiceSettingsRow>();

  select() {
    return {
      from: () => ({
        where: (condition: Condition) => ({
          get: async () => [...this.rows.values()].filter(condition)[0],
        }),
      }),
    };
  }

  insert() {
    return {
      values: (row: VoiceSettingsRow) => ({
        onConflictDoUpdate: async (input: { set: Partial<VoiceSettingsRow> }) => {
          const current = this.rows.get(row.userId);
          const next = { ...current, ...row, ...input.set };
          this.rows.set(next.userId, next);
        },
      }),
    };
  }
}

describe("VoiceRepository", () => {
  let db: VoiceRepositoryTestDb;
  let VoiceRepository: typeof import("../../src/db/repositories/voice").VoiceRepository;

  beforeEach(async () => {
    vi.resetModules();
    ({ VoiceRepository } = await import("../../src/db/repositories/voice"));
    db = new VoiceRepositoryTestDb();
  });

  it("returns undefined when the user has no stored language", async () => {
    const repo = new VoiceRepository(db as never);
    expect(await repo.getLanguage("user-with-no-row")).toBeUndefined();
  });

  it("stores and reads back a language", async () => {
    const repo = new VoiceRepository(db as never);
    await repo.setLanguage({ userId: "u1", language: "es", now: 1 });
    expect(await repo.getLanguage("u1")).toBe("es");
  });

  it("overwrites an existing language rather than inserting a second row", async () => {
    const repo = new VoiceRepository(db as never);
    await repo.setLanguage({ userId: "u1", language: "es", now: 1 });
    await repo.setLanguage({ userId: "u1", language: "fr", now: 2 });
    expect(await repo.getLanguage("u1")).toBe("fr");
  });
});
