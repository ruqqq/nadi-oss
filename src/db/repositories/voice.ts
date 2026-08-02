import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type * as schema from "../schema";
import { userVoiceSettings } from "../schema";

type VoiceRepositoryDb = DrizzleD1Database<typeof schema>;

export class VoiceRepository {
  constructor(private readonly db: VoiceRepositoryDb) {}

  async getLanguage(userId: string): Promise<string | undefined> {
    const row = await this.db
      .select()
      .from(userVoiceSettings)
      .where(eq(userVoiceSettings.userId, userId))
      .get();
    return row?.language;
  }

  async setLanguage(input: { userId: string; language: string; now: number }): Promise<void> {
    await this.db
      .insert(userVoiceSettings)
      .values({
        userId: input.userId,
        language: input.language,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoUpdate({
        target: userVoiceSettings.userId,
        set: { language: input.language, updatedAt: input.now },
      });
  }
}
