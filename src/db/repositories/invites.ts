import { and, desc, eq, ne, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { invites, waitingList, type Invite, type WaitingListEntry } from "../schema";
import type * as schema from "../schema";

/** Invites an ordinary (non-superuser) account may have accepted. */
export const INVITE_LIMIT = 5;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class InviteRepository {
  constructor(private readonly db: DrizzleD1Database<typeof schema>) {}

  async listForInviter(inviterUserId: string): Promise<Invite[]> {
    return this.db
      .select()
      .from(invites)
      .where(eq(invites.inviterUserId, inviterUserId))
      .orderBy(desc(invites.createdAt))
      .all();
  }

  async createLink(inviterUserId: string, token: string): Promise<Invite> {
    const row = {
      id: crypto.randomUUID(),
      token,
      inviterUserId,
      email: null,
      status: "pending",
      acceptedUserId: null,
      createdAt: Date.now(),
      claimedAt: null,
      acceptedAt: null,
    } satisfies typeof invites.$inferInsert;
    await this.db.insert(invites).values(row);
    return row as Invite;
  }

  /** Direct invite: already bound to an email, no link to share. */
  async createForEmail(inviterUserId: string, email: string): Promise<Invite> {
    const now = Date.now();
    const row = {
      id: crypto.randomUUID(),
      token: null,
      inviterUserId,
      email: normalizeEmail(email),
      status: "claimed",
      acceptedUserId: null,
      createdAt: now,
      claimedAt: now,
      acceptedAt: null,
    } satisfies typeof invites.$inferInsert;
    await this.db.insert(invites).values(row);
    return row as Invite;
  }

  async findById(id: string): Promise<Invite | null> {
    return (await this.db.select().from(invites).where(eq(invites.id, id)).get()) ?? null;
  }

  async findByToken(token: string): Promise<Invite | null> {
    return (await this.db.select().from(invites).where(eq(invites.token, token)).get()) ?? null;
  }

  async findByEmail(email: string): Promise<Invite | null> {
    return (
      (await this.db
        .select()
        .from(invites)
        .where(eq(invites.email, normalizeEmail(email)))
        .orderBy(desc(invites.createdAt))
        .get()) ?? null
    );
  }

  /** Bind a pending link invite to an email. */
  async claim(id: string, email: string): Promise<void> {
    await this.db
      .update(invites)
      .set({ email: normalizeEmail(email), status: "claimed", claimedAt: Date.now() })
      .where(and(eq(invites.id, id), eq(invites.status, "pending")))
      .run();
  }

  /**
   * Consume the inviter's slot once the invitee has a real account. No-op when
   * the email was never invited (superuser, whitelisted, or a pre-existing user).
   */
  async markAccepted(email: string, userId: string): Promise<void> {
    await this.db
      .update(invites)
      .set({ status: "accepted", acceptedUserId: userId, acceptedAt: Date.now() })
      .where(and(eq(invites.email, normalizeEmail(email)), eq(invites.status, "claimed")))
      .run();
  }

  async countAccepted(inviterUserId: string): Promise<number> {
    const row = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(invites)
      .where(and(eq(invites.inviterUserId, inviterUserId), eq(invites.status, "accepted")))
      .get();
    return row?.count ?? 0;
  }

  /** Revoke an own, not-yet-accepted invite. Returns false if nothing matched. */
  async revoke(id: string, inviterUserId: string): Promise<boolean> {
    const res = await this.db
      .delete(invites)
      .where(
        and(
          eq(invites.id, id),
          eq(invites.inviterUserId, inviterUserId),
          ne(invites.status, "accepted"),
        ),
      )
      .run();
    return (res.meta?.changes ?? 0) > 0;
  }
}

export class WaitingListRepository {
  constructor(private readonly db: DrizzleD1Database<typeof schema>) {}

  async record(email: string): Promise<void> {
    const now = Date.now();
    await this.db
      .insert(waitingList)
      .values({ email: normalizeEmail(email), attempts: 1, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: waitingList.email,
        set: { attempts: sql`${waitingList.attempts} + 1`, updatedAt: now },
      })
      .run();
  }

  async list(): Promise<WaitingListEntry[]> {
    return this.db.select().from(waitingList).orderBy(desc(waitingList.updatedAt)).all();
  }

  async remove(email: string): Promise<void> {
    await this.db
      .delete(waitingList)
      .where(eq(waitingList.email, normalizeEmail(email)))
      .run();
  }
}
