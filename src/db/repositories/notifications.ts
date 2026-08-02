import { and, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type * as schema from "../schema";
import { pushSubscriptions, userNotificationSettings } from "../schema";

type NotificationRepositoryDb = DrizzleD1Database<typeof schema>;

export class NotificationRepository {
  constructor(private readonly db: NotificationRepositoryDb) {}

  async getBrowserSettings(userId: string) {
    return this.db
      .select()
      .from(userNotificationSettings)
      .where(eq(userNotificationSettings.userId, userId))
      .get();
  }

  /**
   * Partial update: a caller that sends one switch must not clobber the other.
   * The insert half needs a concrete value for every column, so an absent field
   * inserts the column default; the update half only sets what was sent.
   */
  async updateBrowserSettings(input: {
    userId: string;
    browserPushEnabled?: boolean;
    pushPreviewEnabled?: boolean;
    now: number;
  }) {
    await this.db
      .insert(userNotificationSettings)
      .values({
        userId: input.userId,
        browserPushEnabled: input.browserPushEnabled ?? false,
        pushPreviewEnabled: input.pushPreviewEnabled ?? true,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoUpdate({
        target: userNotificationSettings.userId,
        set: {
          ...(input.browserPushEnabled === undefined
            ? {}
            : { browserPushEnabled: input.browserPushEnabled }),
          ...(input.pushPreviewEnabled === undefined
            ? {}
            : { pushPreviewEnabled: input.pushPreviewEnabled }),
          updatedAt: input.now,
        },
      });
  }

  async upsertSubscription(input: {
    userId: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    userAgent: string | null;
    now: number;
  }) {
    await this.db
      .insert(pushSubscriptions)
      .values({
        id: crypto.randomUUID(),
        userId: input.userId,
        endpoint: input.endpoint,
        p256dh: input.p256dh,
        auth: input.auth,
        userAgent: input.userAgent,
        createdAt: input.now,
        updatedAt: input.now,
        lastSeenAt: input.now,
      })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: {
          userId: input.userId,
          p256dh: input.p256dh,
          auth: input.auth,
          userAgent: input.userAgent,
          updatedAt: input.now,
          lastSeenAt: input.now,
        },
      });
  }

  async deleteSubscriptionByEndpoint(input: { userId: string; endpoint: string }) {
    await this.db
      .delete(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.userId, input.userId),
          eq(pushSubscriptions.endpoint, input.endpoint),
        ),
      );
  }

  async deleteSubscriptionId(id: string) {
    await this.db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, id));
  }

  async listSubscriptionsForUser(userId: string) {
    return this.db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId))
      .all();
  }
}
