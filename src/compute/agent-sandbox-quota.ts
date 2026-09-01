import type { AgentSandboxLedger } from "./agent-sandbox-ledger";
import type { BackendReference } from "./backend";
import { ComputeError } from "./errors";
import { log } from "../log";

export const DEFAULT_MAX_ACTIVE_AGENT_SANDBOXES = 10;

/**
 * A busy DO is single-threaded; never let its queue stall the caller's turn.
 *
 * A reclaim is a RELEASE, never a destroy: on a provider with native idle
 * suspend it is a no-op that only moves bookkeeping, and elsewhere it backs
 * /workspace up first, which a real repository checkout can take seconds to do.
 * Too tight a bound turns a reclaim that is about to succeed into a counted
 * refusal, so the user sees quota_exhausted while a slot is in fact being freed.
 */
export const RECLAIM_RPC_TIMEOUT_MS = 15_000;

/**
 * Reclaim candidates are tried sequentially, so without a cap a caller unlucky
 * enough to hit every refusal would wait up to limit * RECLAIM_RPC_TIMEOUT_MS.
 * Candidates are least-recently-used first, so the first few are the best
 * reclaims; beyond this many refusals, surface quota_exhausted instead of
 * burning more caller time. Worst case 3 * 15s = ~45s.
 */
export const MAX_RECLAIM_ATTEMPTS = 3;

/**
 * LRU order does not imply the LRU candidate is idle: the least-recently-used
 * box can belong to an agent that is mid-turn (a model turn touches the box
 * only when it runs a tool). Never reclaim a box that was in use within this
 * window. Enforced on the TARGET, in `ThreadComputeService.releaseIfReclaimable`.
 */
export const RECLAIM_MIN_IDLE_MS = 60_000;

/**
 * The workspace's concurrency cap on live agent sandboxes.
 *
 * Every method names a transition of the D1 row, and the two that look alike
 * are the ones that must never be confused:
 *
 * - {@link idle} — the box went to sleep. The row STAYS; only its slot is freed.
 * - {@link forget} — the box was DESTROYED. The row goes.
 *
 * Calling `forget` where `idle` belongs strands a live sprite with no ledger
 * row, which the orphan reconciler then deletes — the unrecoverable direction.
 */
export interface AgentSandboxGate {
  /** Claim a slot before the provider is asked for a box. Throws `quota_exhausted`. */
  admit(): Promise<void>;
  /** The provider handed back a box: record which machine it is, and go `active`. */
  recordRuntime(runtime: BackendReference): Promise<void>;
  /** Keep an active row warm. */
  refresh(): Promise<void>;
  /** The box hibernated or was released to a snapshot: free the slot, KEEP the row. */
  idle(): Promise<void>;
  /** The box was destroyed: drop the row. */
  forget(): Promise<void>;
}

/** Mirrors the THINK_COMPACT_AFTER_TOKENS idiom (src/agent/think-thread-agent.ts). */
export function parseMaxActiveAgentSandboxes(value: unknown): number {
  const parsed =
    typeof value === "string" && value.trim() !== "" ? Number(value.trim()) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_MAX_ACTIVE_AGENT_SANDBOXES;
}

/**
 * The limit for a provider whose capacity is NOT ours to ration (BYOK).
 *
 * The row is still written — it is what names the agent's machine for the
 * reconciler and what makes the insert a lease — but nothing is refused. Not
 * `Infinity`: D1 binds a JS number into SQLite, and a non-finite one is not a
 * value SQLite compares.
 */
export const UNLIMITED_AGENT_SANDBOXES = Number.MAX_SAFE_INTEGER;

export function createAgentSandboxGate(input: {
  ledger: AgentSandboxLedger;
  workspaceId: string;
  agentId: string;
  provider: string;
  /** REQUIRED. {@link UNLIMITED_AGENT_SANDBOXES} for a provider we do not ration. */
  limit: number;
  /** REQUIRED. `null` for a provider with no enumerable machine name. */
  externalRuntimeId: (runtime: BackendReference) => string | null;
  now: () => number;
  reclaim: (agentId: string) => Promise<boolean>;
}): AgentSandboxGate {
  const tryAdmit = () =>
    input.ledger.tryAdmit({
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      provider: input.provider,
      now: input.now(),
      limit: input.limit,
    });

  return {
    async admit(): Promise<void> {
      if (await tryAdmit()) return;

      // At the cap. Ask the least-recently-used OTHER agent to put its box to
      // sleep — that frees exactly what an idle wake would have freed anyway,
      // and it never destroys anything.
      const candidates = await input.ledger.listReclaimCandidates({
        workspaceId: input.workspaceId,
        excludeAgentId: input.agentId,
      });

      for (const candidate of candidates.slice(0, MAX_RECLAIM_ATTEMPTS)) {
        let released = false;
        try {
          released = await input.reclaim(candidate.agentId);
        } catch {
          released = false; // unreachable/slow DO == refusal, never a hard failure
        }
        if (!released) continue;
        // The reclaimed agent marks its OWN row idle; do not depend on that
        // having landed. Marking it here too is idempotent, and — unlike the
        // ledger this replaces — it is a status change, NOT a delete: the
        // reclaimed box still exists.
        await input.ledger.markIdle({ agentId: candidate.agentId, now: input.now() });
        if (await tryAdmit()) return;
      }

      // A reclaim RPC that timed out is counted as a refusal, but the target DO
      // keeps going and may finish moments later. One last attempt turns that
      // spurious refusal into a success instead of telling the user the
      // workspace is full when a slot has just been freed.
      if (await tryAdmit()) return;

      const active = await input.ledger.countActive(input.workspaceId);
      // The user has no direct access to the sandbox, so a bare code is useless
      // to them. Say what is happening and what resolves it.
      throw new ComputeError(
        "quota_exhausted",
        `All ${active} sandbox slots for this workspace are busy running work for other agents ` +
          `(limit ${input.limit}). Slots free up automatically as that work finishes; ` +
          `retry shortly, or stop work on another agent to free one now.`,
      );
    },

    async recordRuntime(runtime: BackendReference): Promise<void> {
      const externalId = input.externalRuntimeId(runtime);
      if (externalId === null) {
        // Not a failure — several providers have no enumerable machine name —
        // but it IS the condition under which the orphan reconciler can never
        // account for this box, so it must be visible rather than inferred.
        log.info("compute.sandbox_external_id_absent", {
          agentId: input.agentId,
          provider: input.provider,
        });
      }
      await input.ledger.recordSprite({
        agentId: input.agentId,
        provider: input.provider,
        externalId,
        now: input.now(),
      });
    },

    async refresh(): Promise<void> {
      await input.ledger.touch({ agentId: input.agentId, now: input.now() });
    },

    async idle(): Promise<void> {
      await input.ledger.markIdle({ agentId: input.agentId, now: input.now() });
    },

    async forget(): Promise<void> {
      await input.ledger.remove(input.agentId);
    },
  };
}
