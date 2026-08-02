import type { ContainerLedgerRow } from "./types";

export type { ContainerLedgerRow };

/**
 * Cross-thread ledger of live containers, backed by D1.
 *
 * Admission is ONE statement: the row is only written when the workspace is
 * under its limit, so the insert IS the lease. A read-then-insert would be
 * check-then-act — two concurrent DOs would both observe `limit - 1` and both
 * admit.
 */
export class ContainerLedger {
  constructor(private readonly db: D1Database) {}

  /**
   * Atomically claim a slot. Returns true iff this thread now holds one.
   *
   * `ON CONFLICT ... DO UPDATE` makes re-admitting the same thread idempotent:
   * a thread that already holds a slot re-acquiring its container must not be
   * refused by its own row, nor consume a second slot.
   */
  async tryAdmit(input: {
    threadId: string;
    workspaceId: string;
    provider: string;
    profile: string;
    now: number;
    ttlMs: number;
    limit: number;
  }): Promise<boolean> {
    const expiresAt = input.now + input.ttlMs;

    // Opportunistic prune: an expired row must never consume a slot, and this
    // is what makes a leaked lease self-heal instead of wedging the workspace.
    await this.db
      .prepare("DELETE FROM active_containers WHERE workspace_id = ?1 AND expires_at <= ?2")
      .bind(input.workspaceId, input.now)
      .run();

    const result = await this.db
      .prepare(
        `INSERT INTO active_containers
           (thread_id, workspace_id, provider, profile, last_used_at, expires_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6
         WHERE (
           SELECT COUNT(*) FROM active_containers
           WHERE workspace_id = ?2 AND expires_at > ?5 AND thread_id <> ?1
         ) < ?7
         ON CONFLICT(thread_id) DO UPDATE SET
           last_used_at = excluded.last_used_at,
           expires_at   = excluded.expires_at,
           provider     = excluded.provider,
           profile      = excluded.profile,
           workspace_id = excluded.workspace_id`,
      )
      .bind(
        input.threadId,
        input.workspaceId,
        input.provider,
        input.profile,
        input.now,
        expiresAt,
        input.limit,
      )
      .run();

    const changes = result.meta?.changes;
    if (typeof changes === "number") return changes > 0;

    // meta.changes is not trustworthy everywhere: local D1 returned `null` for
    // this exact statement while remote returned an integer, and DO SQLite's
    // rowsWritten does not report 0 for a skipped INSERT OR IGNORE
    // (src/agent/injection-buffer.ts:75). A false "admitted" would silently
    // defeat the entire cap while every test stayed green, so confirm by
    // reading the row back.
    return await this.holdsSlot(input.threadId, input.now);
  }

  private async holdsSlot(threadId: string, now: number): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT 1 FROM active_containers WHERE thread_id = ?1 AND expires_at > ?2")
      .bind(threadId, now)
      .first();
    return row != null;
  }

  /**
   * Refresh a live thread's expiry. Self-healing: if the row was ever pruned
   * (e.g. the opportunistic-expiry sweep in {@link tryAdmit}) while the
   * container it represents is still alive, a bare UPDATE would silently
   * match zero rows and the live container would become invisible to the
   * cap. So after the UPDATE we always confirm the row exists and, if not,
   * re-claim a slot via the same conditional-insert path `tryAdmit` uses.
   * That path is fail-safe by construction: if the workspace is genuinely at
   * its cap, the re-claim just does not insert — it must never throw.
   *
   * Returns whether the thread holds a slot afterwards. A `false` here means a
   * live container has NO ledger row (the workspace was at its cap when the
   * re-claim ran), i.e. the cap is being silently over-subscribed — callers
   * must surface that rather than discard it.
   */
  async refresh(input: {
    threadId: string;
    workspaceId: string;
    provider: string;
    profile: string;
    now: number;
    ttlMs: number;
    limit: number;
  }): Promise<boolean> {
    await this.db
      .prepare(
        "UPDATE active_containers SET last_used_at = ?2, expires_at = ?3 WHERE thread_id = ?1",
      )
      .bind(input.threadId, input.now, input.now + input.ttlMs)
      .run();

    if (await this.holdsSlot(input.threadId, input.now)) return true;

    return await this.tryAdmit({
      threadId: input.threadId,
      workspaceId: input.workspaceId,
      provider: input.provider,
      profile: input.profile,
      now: input.now,
      ttlMs: input.ttlMs,
      limit: input.limit,
    });
  }

  async release(threadId: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM active_containers WHERE thread_id = ?1")
      .bind(threadId)
      .run();
  }

  async countActive(input: { workspaceId: string; now: number }): Promise<number> {
    const row = await this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM active_containers WHERE workspace_id = ?1 AND expires_at > ?2",
      )
      .bind(input.workspaceId, input.now)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  /** Live rows for this workspace, least-recently-used first, excluding self. */
  async listReclaimCandidates(input: {
    workspaceId: string;
    excludeThreadId: string;
    now: number;
  }): Promise<ContainerLedgerRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT thread_id, workspace_id, provider, profile, last_used_at, expires_at
         FROM active_containers
         WHERE workspace_id = ?1 AND thread_id <> ?2 AND expires_at > ?3
         ORDER BY last_used_at ASC`,
      )
      .bind(input.workspaceId, input.excludeThreadId, input.now)
      .all<{
        thread_id: string;
        workspace_id: string;
        provider: string;
        profile: string;
        last_used_at: number;
        expires_at: number;
      }>();

    return results.map((r) => ({
      threadId: r.thread_id,
      workspaceId: r.workspace_id,
      provider: r.provider,
      profile: r.profile,
      lastUsedAt: r.last_used_at,
      expiresAt: r.expires_at,
    }));
  }
}
