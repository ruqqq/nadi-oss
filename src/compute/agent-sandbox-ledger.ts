import type { AgentSandboxLedgerRow, AgentSandboxStatus } from "./types";

export type { AgentSandboxLedgerRow, AgentSandboxStatus };

/**
 * Cross-agent ledger of sandboxes, backed by D1 (`agent_sandboxes`).
 *
 * Replaces `active_containers`, whose unit was a thread-with-a-container and
 * whose lease was a TTL. Since P3 the box belongs to the AGENT and outlives
 * every one of its threads, so neither of those still describes reality:
 *
 * - **The unit is the agent.** One row per agent, `agent_id` as the primary
 *   key, so an agent can never hold two boxes.
 * - **The row has no expiry.** A sprite lives until something DELETEs it, so a
 *   row that lapsed on its own would either under-count a box that still bills
 *   (a stranded sprite) or invite a reaper to delete a live filesystem. The row
 *   is written when the box is claimed and deleted when the box is destroyed,
 *   and nothing else ends it.
 * - **`status` carries the concurrency answer, not existence.** `active` is
 *   awake and consumes a workspace slot; `idle` is hibernated with its disk
 *   intact and consumes none; `acquiring` is a claimed slot whose sprite may or
 *   may not have been created yet. ALL THREE mean a box may exist, which is
 *   what keeps the orphan reconciler off a disabled agent's sprite.
 *
 * **There is no `workspace_id` column** — an agent already belongs to exactly
 * one workspace, and duplicating that here would create a second answer that
 * can disagree. Every workspace-scoped statement therefore JOINs `agents`.
 */
export class AgentSandboxLedger {
  constructor(private readonly db: D1Database) {}

  /**
   * Atomically claim this workspace's slot for `agentId`, moving the row to
   * `acquiring`. Returns true iff the agent now holds one.
   *
   * ONE statement, so the insert IS the lease: a read-then-insert is
   * check-then-act, and two agents cold-starting at once would both observe
   * `limit - 1` and both admit.
   *
   * `ON CONFLICT DO UPDATE` makes re-admitting the same agent idempotent — an
   * `idle` box waking up must not be refused by its own row, nor consume a
   * second slot. `sprite_name` is deliberately NOT touched here: a wake keeps
   * the name it already had, and a fresh acquire overwrites it through
   * {@link recordSprite} once the provider has actually created one.
   *
   * Only slot-holding rows count against the limit. An `idle` agent's sprite is
   * hibernated — disk billed, no compute, no provider concurrency — so counting
   * it would turn a cap on concurrency into a cap on how many agents may ever
   * have had a box: once N agents had run, the (N+1)th could never get one
   * again. `acquiring` DOES count, or two racing cold starts both pass the cap.
   */
  async tryAdmit(input: {
    agentId: string;
    workspaceId: string;
    provider: string;
    now: number;
    limit: number;
  }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT INTO agent_sandboxes (agent_id, provider, status, created_at, last_used_at)
         SELECT ?1, ?2, 'acquiring', ?3, ?3
         WHERE (
           SELECT COUNT(*) FROM agent_sandboxes s
             JOIN agents a ON a.id = s.agent_id
           WHERE a.workspace_id = ?4
             AND s.status IN ('acquiring', 'active')
             AND s.agent_id <> ?1
         ) < ?5
         ON CONFLICT(agent_id) DO UPDATE SET
           status       = 'acquiring',
           provider     = excluded.provider,
           last_used_at = excluded.last_used_at`,
      )
      .bind(input.agentId, input.provider, input.now, input.workspaceId, input.limit)
      .run();

    const changes = result.meta?.changes;
    if (typeof changes === "number") return changes > 0;
    // `meta.changes` is not trustworthy everywhere — local D1 returned null for
    // the equivalent `active_containers` statement while remote returned an
    // integer. A false "admitted" would silently defeat the cap while every
    // test stayed green, so confirm by reading the row back.
    return await this.holdsSlot(input.agentId);
  }

  private async holdsSlot(agentId: string): Promise<boolean> {
    const row = await this.db
      .prepare(
        "SELECT 1 FROM agent_sandboxes WHERE agent_id = ?1 AND status IN ('acquiring','active')",
      )
      .bind(agentId)
      .first();
    return row != null;
  }

  /**
   * The provider has created the box: record which one, and promote the row to
   * `active`.
   *
   * `sprite_name` is the ONLY link between a row and a provider-side machine,
   * and the orphan reconciler reaps exactly the sprites it cannot find here —
   * so a missing write here is a sprite that gets DELETED, not merely one that
   * bills. It is written on the acquire path immediately after the provider
   * returns, and `externalId` is `null` only for a provider that has no
   * enumerable machine name (see `ComputeBackend.externalRuntimeId`).
   */
  async recordSprite(input: {
    agentId: string;
    externalId: string | null;
    now: number;
  }): Promise<void> {
    await this.db
      .prepare(
        `UPDATE agent_sandboxes
            SET status = 'active', sprite_name = ?2, last_used_at = ?3
          WHERE agent_id = ?1`,
      )
      .bind(input.agentId, input.externalId, input.now)
      .run();
  }

  /** Keep an ACTIVE row warm. Never resurrects an idle row — a wake goes through {@link tryAdmit}. */
  async touch(input: { agentId: string; now: number }): Promise<void> {
    await this.db
      .prepare(
        "UPDATE agent_sandboxes SET last_used_at = ?2 WHERE agent_id = ?1 AND status = 'active'",
      )
      .bind(input.agentId, input.now)
      .run();
  }

  /**
   * The box went to sleep: free its concurrency slot, KEEP its row.
   *
   * Deleting the row here is the mistake this method exists to prevent — the
   * sprite is still there, hibernated with the user's filesystem on it, and a
   * row-less sprite is precisely what the orphan reconciler deletes.
   */
  async markIdle(input: { agentId: string; now: number }): Promise<void> {
    await this.db
      .prepare("UPDATE agent_sandboxes SET status = 'idle', last_used_at = ?2 WHERE agent_id = ?1")
      .bind(input.agentId, input.now)
      .run();
  }

  /** The box is GONE (destroyed, or never created). Only ever called after a destroy. */
  async remove(agentId: string): Promise<void> {
    await this.db.prepare("DELETE FROM agent_sandboxes WHERE agent_id = ?1").bind(agentId).run();
  }

  /** How many agents in this workspace hold a concurrency slot right now. */
  async countActive(workspaceId: string): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM agent_sandboxes s
           JOIN agents a ON a.id = s.agent_id
          WHERE a.workspace_id = ?1 AND s.status IN ('acquiring', 'active')`,
      )
      .bind(workspaceId)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  /**
   * Slot-holding rows for this workspace, least-recently-used first, excluding
   * self. `acquiring` rows are excluded: there is nothing to release yet, and
   * asking is a wasted cross-DO RPC against a DO that is mid-acquire.
   */
  async listReclaimCandidates(input: {
    workspaceId: string;
    excludeAgentId: string;
  }): Promise<AgentSandboxLedgerRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT s.agent_id, a.workspace_id, s.provider, s.sprite_name, s.status, s.last_used_at
           FROM agent_sandboxes s
           JOIN agents a ON a.id = s.agent_id
          WHERE a.workspace_id = ?1 AND s.agent_id <> ?2 AND s.status = 'active'
          ORDER BY s.last_used_at ASC`,
      )
      .bind(input.workspaceId, input.excludeAgentId)
      .all<{
        agent_id: string;
        workspace_id: string;
        provider: string;
        sprite_name: string | null;
        status: string;
        last_used_at: number | null;
      }>();

    return results.map((r) => ({
      agentId: r.agent_id,
      workspaceId: r.workspace_id,
      provider: r.provider,
      spriteName: r.sprite_name,
      status: r.status as AgentSandboxStatus,
      lastUsedAt: r.last_used_at ?? 0,
    }));
  }

  /**
   * Every provider-side machine name this deployment believes exists, across
   * ALL workspaces and every status.
   *
   * Deliberately unscoped. The reconciler subtracts this set from the
   * provider's own list, so a name missing from it is DELETED — scoping the
   * query narrower than the provider's answer would reap another workspace's
   * live box. A superset is safe; a subset destroys a filesystem.
   */
  async listKnownSpriteNames(): Promise<Set<string>> {
    const { results } = await this.db
      .prepare("SELECT sprite_name FROM agent_sandboxes WHERE sprite_name IS NOT NULL")
      .all<{ sprite_name: string }>();
    return new Set(results.map((r) => r.sprite_name));
  }

  /**
   * How many rows are stuck mid-acquire since after `since`.
   *
   * The reconciler's blocker: such a row may own a sprite whose name was never
   * recorded, and a reap pass run beside one could delete the machine it is
   * still provisioning.
   */
  async countAcquiringSince(since: number): Promise<number> {
    const row = await this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM agent_sandboxes WHERE status = 'acquiring' AND last_used_at > ?1",
      )
      .bind(since)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  /**
   * Drop `acquiring` rows that have not moved since `before`. Returns how many went.
   *
   * Without this one wedged acquire would block reconciliation for good, and
   * every sprite stranded after it would bill forever.
   */
  async clearStaleAcquiring(before: number): Promise<number> {
    const result = await this.db
      .prepare("DELETE FROM agent_sandboxes WHERE status = 'acquiring' AND last_used_at <= ?1")
      .bind(before)
      .run();
    return result.meta?.changes ?? 0;
  }
}
