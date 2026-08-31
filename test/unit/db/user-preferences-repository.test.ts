import { beforeEach, describe, expect, it, vi } from "vitest";

const userPreferences = {
  __table: "user_preferences",
  userId: "userId",
};

vi.mock("drizzle-orm", () => ({
  eq: (column: string, value: unknown) => (row: Record<string, unknown>) => row[column] === value,
}));

vi.mock("../../../src/db/schema", () => ({
  userPreferences,
}));

interface PreferencesRow {
  userId: string;
  showReasoning: boolean;
  createdAt: number;
  updatedAt: number;
}

type Condition = (row: PreferencesRow) => boolean;

class PreferencesTestDb {
  rows = new Map<string, PreferencesRow>();

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
      values: (row: PreferencesRow) => ({
        onConflictDoUpdate: async ({ set }: { set: Partial<PreferencesRow> }) => {
          const existing = this.rows.get(row.userId);
          this.rows.set(row.userId, existing ? { ...existing, ...set } : row);
        },
      }),
    };
  }
}

const { UserPreferencesRepository } = await import("../../../src/db/repositories/user-preferences");

describe("UserPreferencesRepository", () => {
  let db: PreferencesTestDb;

  beforeEach(() => {
    db = new PreferencesTestDb();
  });

  it("returns undefined when the user has no row", async () => {
    const repo = new UserPreferencesRepository(db as never);
    expect(await repo.getShowReasoning("user-1")).toBeUndefined();
  });

  it("stores and reads back a preference", async () => {
    const repo = new UserPreferencesRepository(db as never);
    await repo.setShowReasoning({ userId: "user-1", showReasoning: false, now: 1000 });
    expect(await repo.getShowReasoning("user-1")).toBe(false);
  });

  it("updates an existing row without resetting createdAt", async () => {
    const repo = new UserPreferencesRepository(db as never);
    await repo.setShowReasoning({ userId: "user-1", showReasoning: false, now: 1000 });
    await repo.setShowReasoning({ userId: "user-1", showReasoning: true, now: 2000 });
    const row = db.rows.get("user-1");
    expect(row?.showReasoning).toBe(true);
    expect(row?.createdAt).toBe(1000);
    expect(row?.updatedAt).toBe(2000);
  });

  it("keeps users independent", async () => {
    const repo = new UserPreferencesRepository(db as never);
    await repo.setShowReasoning({ userId: "user-1", showReasoning: false, now: 1000 });
    await repo.setShowReasoning({ userId: "user-2", showReasoning: true, now: 1000 });
    expect(await repo.getShowReasoning("user-1")).toBe(false);
    expect(await repo.getShowReasoning("user-2")).toBe(true);
  });
});
