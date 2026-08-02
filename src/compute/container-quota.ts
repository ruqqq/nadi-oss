import type { ContainerLedger } from "./container-ledger";
import { ComputeError } from "./errors";
import { log } from "../log";

export const DEFAULT_MAX_ACTIVE_CONTAINERS = 10;

/** Slack beyond the idle timeout before a ledger row is considered leaked. */
export const LEDGER_GRACE_MS = 60_000;

/**
 * A busy DO is single-threaded; never let its queue stall the caller's turn.
 *
 * A reclaim now always backs /workspace up before destroying the container, and
 * a real repository checkout can take several seconds to snapshot. Too tight a
 * bound turns a reclaim that is about to succeed into a counted refusal, so the
 * user sees quota_exhausted while a slot is in fact being freed.
 */
export const RECLAIM_RPC_TIMEOUT_MS = 15_000;

/**
 * Reclaim candidates are tried sequentially (each RPC is time-boxed by the
 * caller's `reclaim`, but the workspace limit can be as high as 100 — without
 * a cap here, a caller unlucky enough to hit every refusal would wait up to
 * limit * RECLAIM_RPC_TIMEOUT_MS, ~25 minutes at the largest configured limit).
 * Candidates are ordered least-recently-used first, so the first few are the
 * best (and most likely) reclaims; beyond this many refusals in a row, give up
 * and surface quota_exhausted instead of continuing to burn caller time.
 *
 * Worst case is attempts * timeout: 3 * 15s = ~45s.
 */
export const MAX_RECLAIM_ATTEMPTS = 3;

/**
 * LRU order does not imply the LRU candidate is idle: the least-recently-used
 * container can belong to a thread that is mid-turn (a model turn touches the
 * container only when it runs a tool). Never reclaim a container that was in
 * use within this window.
 */
export const RECLAIM_MIN_IDLE_MS = 60_000;

export interface ComputeQuotaGate {
  admit(): Promise<void>;
  /** False iff the thread does NOT hold a slot afterwards (live container, no row). */
  refresh(): Promise<boolean>;
  release(): Promise<void>;
}

/** Mirrors the THINK_COMPACT_AFTER_TOKENS idiom (src/agent/think-thread-agent.ts). */
export function parseMaxActiveContainers(value: unknown): number {
  const parsed =
    typeof value === "string" && value.trim() !== "" ? Number(value.trim()) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_MAX_ACTIVE_CONTAINERS;
}

export function createComputeQuotaGate(input: {
  ledger: ContainerLedger;
  workspaceId: string;
  threadId: string;
  provider: string;
  profile: string;
  idleTimeoutMs: number;
  limit: number;
  now: () => number;
  reclaim: (threadId: string) => Promise<boolean>;
}): ComputeQuotaGate {
  const ttlMs = input.idleTimeoutMs + LEDGER_GRACE_MS;

  const tryAdmit = (now: number) =>
    input.ledger.tryAdmit({
      threadId: input.threadId,
      workspaceId: input.workspaceId,
      provider: input.provider,
      profile: input.profile,
      now,
      ttlMs,
      limit: input.limit,
    });

  return {
    async admit(): Promise<void> {
      const now = input.now();
      if (await tryAdmit(now)) return;

      // At the cap. Reclaim the least-recently-used container whose thread is
      // willing to give it up — that releases early exactly what the idle alarm
      // would have released anyway.
      const candidates = await input.ledger.listReclaimCandidates({
        workspaceId: input.workspaceId,
        excludeThreadId: input.threadId,
        now,
      });

      for (const candidate of candidates.slice(0, MAX_RECLAIM_ATTEMPTS)) {
        let released = false;
        try {
          released = await input.reclaim(candidate.threadId);
        } catch {
          released = false; // unreachable/slow DO == refusal, never a hard failure
        }
        if (!released) continue;
        // The reclaimed thread deletes its own row on release, but do not depend
        // on that having landed: drop it here too, then retry. Both are idempotent.
        await input.ledger.release(candidate.threadId);
        if (await tryAdmit(input.now())) return;
      }

      // A reclaim RPC that timed out is counted as a refusal, but the target DO
      // keeps going and may finish its release moments later. One last attempt
      // turns that spurious refusal into a success instead of telling the user
      // the workspace is full when a slot has just been freed.
      if (await tryAdmit(input.now())) return;

      const active = await input.ledger.countActive({
        workspaceId: input.workspaceId,
        now: input.now(),
      });
      // The user has no direct access to the sandbox, so a bare code is useless
      // to them. Say what is happening and what resolves it.
      throw new ComputeError(
        "quota_exhausted",
        `All ${active} sandbox slots for this workspace are busy running work in other threads ` +
          `(limit ${input.limit}). Slots free up automatically as that work finishes; ` +
          `retry shortly, or stop work in another thread to free one now.`,
      );
    },

    async refresh(): Promise<boolean> {
      const held = await input.ledger.refresh({
        threadId: input.threadId,
        workspaceId: input.workspaceId,
        provider: input.provider,
        profile: input.profile,
        now: input.now(),
        ttlMs,
        limit: input.limit,
      });
      if (!held) {
        // A live container with no ledger row over-subscribes the workspace cap
        // and is invisible to reclaim. Never throw (that would break the turn) —
        // but never swallow it either: this must be detectable.
        log.warn("compute.quota_refresh_no_slot", {
          threadId: input.threadId,
          workspaceId: input.workspaceId,
          limit: input.limit,
        });
      }
      return held;
    },

    async release(): Promise<void> {
      await input.ledger.release(input.threadId);
    },
  };
}
