import { beforeEach, describe, expect, it, vi } from "vitest";

const now = 1_800_000_000_000;

const pushSubscriptions = {
  __table: "push_subscriptions",
  endpoint: "endpoint",
  userId: "userId",
  id: "id",
};
const userNotificationSettings = {
  __table: "user_notification_settings",
  userId: "userId",
};

vi.mock("drizzle-orm", () => ({
  eq: (column: string, value: unknown) => (row: Record<string, unknown>) => row[column] === value,
  and:
    (...conditions: Array<(row: Record<string, unknown>) => boolean>) =>
    (row: Record<string, unknown>) =>
      conditions.every((condition) => condition(row)),
}));

vi.mock("../../../src/db/schema", () => ({
  pushSubscriptions,
  userNotificationSettings,
}));

interface BrowserSettingsRow {
  userId: string;
  browserPushEnabled: boolean;
  pushPreviewEnabled: boolean;
  createdAt: number;
  updatedAt: number;
}

interface SubscriptionRow {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
  createdAt: number;
  updatedAt: number;
  lastSeenAt: number;
}

type Row = BrowserSettingsRow | SubscriptionRow;
type Condition = (row: Row) => boolean;

class NotificationRepositoryTestDb {
  browserSettings = new Map<string, BrowserSettingsRow>();
  subscriptions = new Map<string, SubscriptionRow>();

  select() {
    return {
      from: (table: { __table: string }) => ({
        where: (condition: Condition) => ({
          get: async () => this.read(table, condition)[0],
          all: async () => this.read(table, condition),
        }),
      }),
    };
  }

  insert(table: { __table: string }) {
    return {
      values: (row: Row) => ({
        onConflictDoUpdate: async (input: { set: Partial<Row> }) => {
          this.upsert(table, row, input.set);
        },
      }),
    };
  }

  delete(table: { __table: string }) {
    return {
      where: async (condition: Condition) => {
        this.remove(table, condition);
      },
    };
  }

  private read(table: { __table: string }, condition: Condition) {
    const rows =
      table.__table === "user_notification_settings"
        ? [...this.browserSettings.values()]
        : [...this.subscriptions.values()];
    return rows.filter((row) => condition(row));
  }

  /**
   * Mirrors SQLite: on a fresh insert the VALUES land; on a conflict ONLY the
   * `set` clause is applied. Spreading `row` over an existing row would let a
   * partial update silently clobber columns it never named — which is the bug
   * this table's callers must not have.
   */
  private upsert(table: { __table: string }, row: Row, set: Partial<Row>) {
    if (table.__table === "user_notification_settings") {
      const current = this.browserSettings.get((row as BrowserSettingsRow).userId);
      const next = (current ? { ...current, ...set } : { ...row }) as BrowserSettingsRow;
      this.browserSettings.set(next.userId, next);
      return;
    }

    const current = this.subscriptions.get((row as SubscriptionRow).endpoint);
    const next = (current ? { ...current, ...set } : { ...row }) as SubscriptionRow;
    this.subscriptions.set(next.endpoint, next);
  }

  private remove(table: { __table: string }, condition: Condition) {
    if (table.__table !== "push_subscriptions") return;
    for (const [endpoint, row] of this.subscriptions.entries()) {
      if (condition(row)) this.subscriptions.delete(endpoint);
    }
  }
}

describe("NotificationRepository", () => {
  let db: NotificationRepositoryTestDb;
  let NotificationRepository: typeof import("../../../src/db/repositories/notifications").NotificationRepository;

  beforeEach(async () => {
    vi.resetModules();
    ({ NotificationRepository } = await import("../../../src/db/repositories/notifications"));
    db = new NotificationRepositoryTestDb();
  });

  it("upserts browser settings", async () => {
    const repo = new NotificationRepository(db as never);
    await repo.updateBrowserSettings({ userId: "u1", browserPushEnabled: true, now });

    await expect(repo.getBrowserSettings("u1")).resolves.toMatchObject({
      userId: "u1",
      browserPushEnabled: true,
    });
  });

  it("defaults a newly created row to previews on", async () => {
    const repo = new NotificationRepository(db as never);
    await repo.updateBrowserSettings({ userId: "u1", browserPushEnabled: true, now });

    await expect(repo.getBrowserSettings("u1")).resolves.toMatchObject({
      pushPreviewEnabled: true,
    });
  });

  // Each switch in the UI sends only its own field; one must not clobber the other.
  it("updates previews without touching the push toggle", async () => {
    const repo = new NotificationRepository(db as never);
    await repo.updateBrowserSettings({ userId: "u1", browserPushEnabled: true, now });
    await repo.updateBrowserSettings({ userId: "u1", pushPreviewEnabled: false, now });

    await expect(repo.getBrowserSettings("u1")).resolves.toMatchObject({
      browserPushEnabled: true,
      pushPreviewEnabled: false,
    });
  });

  it("upserts a subscription by endpoint", async () => {
    const repo = new NotificationRepository(db as never);
    await repo.upsertSubscription({
      userId: "u1",
      endpoint: "https://push.example/sub",
      p256dh: "key",
      auth: "auth",
      userAgent: "Vitest",
      now,
    });
    await repo.upsertSubscription({
      userId: "u1",
      endpoint: "https://push.example/sub",
      p256dh: "key2",
      auth: "auth2",
      userAgent: "Vitest 2",
      now: now + 1,
    });

    await expect(repo.listSubscriptionsForUser("u1")).resolves.toEqual([
      expect.objectContaining({
        userId: "u1",
        endpoint: "https://push.example/sub",
        p256dh: "key2",
        auth: "auth2",
        userAgent: "Vitest 2",
        updatedAt: now + 1,
        lastSeenAt: now + 1,
      }),
    ]);
  });
});
