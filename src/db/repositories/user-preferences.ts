import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type * as schema from "../schema";
import { userPreferences } from "../schema";

type UserPreferencesDb = DrizzleD1Database<typeof schema>;

export class UserPreferencesRepository {
  constructor(private readonly db: UserPreferencesDb) {}

  /** `undefined` = no row yet, which the caller renders as the default. */
  async getShowReasoning(userId: string): Promise<boolean | undefined> {
    const row = await this.db
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, userId))
      .get();
    return row?.showReasoning;
  }

  async setShowReasoning(input: {
    userId: string;
    showReasoning: boolean;
    now: number;
  }): Promise<void> {
    await this.db
      .insert(userPreferences)
      .values({
        userId: input.userId,
        showReasoning: input.showReasoning,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoUpdate({
        target: userPreferences.userId,
        set: { showReasoning: input.showReasoning, updatedAt: input.now },
      });
  }
}
