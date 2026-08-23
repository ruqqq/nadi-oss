import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./schema";
import { artifacts, type ArtifactRow } from "./schema";

export type { ArtifactRow };

export class ArtifactRepository {
  private db: DrizzleD1Database<typeof schema>;

  constructor(d1: D1Database) {
    this.db = drizzle(d1, { schema });
  }

  async insert(row: {
    id: string;
    workspaceId: string;
    threadId: string;
    title: string;
    entryPath: string;
    fileCount: number;
    byteSize: number;
    r2Prefix: string;
    status: "active";
    expiresAt: number;
    createdAt: number;
  }): Promise<void> {
    await this.db.insert(artifacts).values(row);
  }

  async getById(id: string): Promise<ArtifactRow | null> {
    const row = await this.db.select().from(artifacts).where(eq(artifacts.id, id)).get();
    return row ?? null;
  }

  async getByIdInThread(id: string, threadId: string): Promise<ArtifactRow | null> {
    const row = await this.db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.id, id), eq(artifacts.threadId, threadId)))
      .get();
    return row ?? null;
  }

  async listByThread(threadId: string): Promise<ArtifactRow[]> {
    return this.db
      .select()
      .from(artifacts)
      .where(eq(artifacts.threadId, threadId))
      .orderBy(desc(artifacts.createdAt))
      .all();
  }

  async markExpired(id: string): Promise<void> {
    await this.db.update(artifacts).set({ status: "expired" }).where(eq(artifacts.id, id));
  }

  async reactivate(id: string, expiresAt: number): Promise<void> {
    await this.db
      .update(artifacts)
      .set({ status: "active", expiresAt })
      .where(eq(artifacts.id, id));
  }
}
