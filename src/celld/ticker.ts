import { DurableObject } from "cloudflare:workers";

import type { Env } from "../env";
import { log, setLogLevel } from "../log";
import { fireDueAutomata } from "../automata/fire-due";
import { autoArchiveIdleThreads } from "../agent/auto-archive";
import { repairStaleThreadSearchProjections } from "../thread-knowledge/repair";
import { RegistryKV } from "../db/registry-kv";
import {
  isDailyWorkDue,
  TICKER_INSTANCE_NAME,
  TICKER_LAST_DAILY_RUN_KEY,
  TICKER_LAST_TICK_KEY,
  TICK_INTERVAL_MS,
} from "./ticker-policy";

/**
 * celld-only replacement for Cloudflare's `scheduled()` handler. celld rejects
 * the `triggers` config key and never invokes `scheduled()`, so without this
 * DO automata never fire, idle threads are never archived, and stale search
 * projections are never repaired — silently. This DO re-arms itself every
 * minute and calls the exact same job functions `scheduled()` calls in
 * `src/index.ts`, unchanged; fire-policy.ts and the claim lease stay
 * verbatim.
 *
 * The ticker holds no state: no next-due timestamps, no cursors, no
 * watermarks. A per-minute cell never idles, and celld only replicates a cell
 * on idle eviction, so ticker-local state would be the least durable state in
 * the system. "Is the daily work due" is decided from registry state — a
 * last-daily-run marker in the registry's `__celld_kv` table — because the
 * registry replicates on idle eviction and survives ticker cell loss and node
 * restarts.
 *
 * Bound only in `wrangler.celld.jsonc` (CRON_TICKER). Cloudflare never sees
 * this class run: it has no CRON_TICKER binding and `scheduled()` instead.
 */
export class CelldTicker extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    setLogLevel(env.LOG_LEVEL);
  }

  async alarm(): Promise<void> {
    const tickedAt = Date.now();

    // Re-arm BEFORE any fallible work: a broken registry, model, or job must
    // not kill the ticker silently. With the next alarm already in place, a
    // throw below only skips this tick's work; the next tick still happens.
    // workerd serializes DO invocations, so the pending alarm cannot overlap
    // this tick — worst case it fires right after.
    await this.ctx.storage.setAlarm(tickedAt + TICK_INTERVAL_MS);

    let automata: { fired: number; skipped: number } | null = null;
    try {
      automata = await fireDueAutomata(this.env);
    } catch (error) {
      log.warn("celld_ticker.automata_failed", { error: String(error) });
    }

    let daily: DailySweepOutcome | null = null;
    try {
      daily = await this.runDailyWorkIfDue(tickedAt);
    } catch (error) {
      log.warn("celld_ticker.daily_failed", { error: String(error) });
    }

    if (this.env.REGISTRY_DO) {
      try {
        // Liveness marker: the ticker keeps no state, so "is it alive?" reads
        // this registry marker (see /api/debug/celld-ticker).
        await new RegistryKV(this.env.REGISTRY_DO).put(TICKER_LAST_TICK_KEY, String(tickedAt));
      } catch (error) {
        log.warn("celld_ticker.marker_failed", { error: String(error) });
      }
    }

    log.info("celld_ticker.tick", {
      tickedAt,
      nextAlarmAt: tickedAt + TICK_INTERVAL_MS,
      automata,
      daily,
    });
  }

  /**
   * Idempotent bootstrap: set the first alarm if none is pending. Called from
   * the Worker fetch path (see `armCelldTicker`); once armed, `alarm()` keeps
   * the ticker armed forever, so a node restart only needs the alarm to
   * survive in the DO's storage — it does not need another fetch.
   */
  async arm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + TICK_INTERVAL_MS);
    }
  }

  private async runDailyWorkIfDue(now: number): Promise<DailySweepOutcome> {
    if (!this.env.REGISTRY_DO) {
      log.warn("celld_ticker.daily_skipped", { reason: "no REGISTRY_DO binding" });
      return { ran: false, reason: "no_registry_do" };
    }
    const kv = new RegistryKV(this.env.REGISTRY_DO);
    const lastRunRaw = await kv.get(TICKER_LAST_DAILY_RUN_KEY);
    const lastRunMs = lastRunRaw === null ? null : Number(lastRunRaw);
    if (!isDailyWorkDue(lastRunMs, now)) {
      return { ran: false, reason: "not_due", lastRunMs };
    }

    const archive = await autoArchiveIdleThreads(this.env);
    const repair = await repairStaleThreadSearchProjections(this.env);

    // Mark only on full success, anchored to the START of the sweep so the
    // next due time does not drift with the run duration. On failure the
    // marker is untouched and the work is retried on the next tick.
    await kv.put(TICKER_LAST_DAILY_RUN_KEY, String(now));
    log.info("celld_ticker.daily_done", { startedAt: now, archive, repair });
    return { ran: true, archive, repair };
  }
}

export type DailySweepOutcome =
  | {
      ran: true;
      archive: { archived: number; skipped: number; failed: number };
      repair: {
        selected: number;
        succeeded: number;
        failed: number;
        remaining: number;
      };
    }
  | { ran: false; reason: "not_due" | "no_registry_do"; lastRunMs?: number | null };

/**
 * Throttle for {@link armCelldTicker}, per isolate. `arm()` is idempotent but
 * it is still a Durable Object RPC, and this runs on the Worker fetch path —
 * unthrottled it is one RPC per request, forever, to re-arm something that
 * re-arms itself every minute. It also keeps the ticker cell permanently
 * resident, which is the opposite of what celld's replicate-on-idle durability
 * model wants from a cell holding no state worth keeping.
 *
 * A throttle rather than a once-per-isolate latch, because the recovery
 * property is the point: if the alarm is ever lost, the next request re-arms
 * it. One window is all that costs.
 */
let lastArmAttemptMs = 0;

/** Test-only: forget the throttle so a test can observe the next attempt. */
export function resetCelldTickerArmThrottle(): void {
  lastArmAttemptMs = 0;
}

/**
 * celld-only: ensure the ticker's first alarm exists. Called from the Worker
 * fetch path. Cloudflare has no CRON_TICKER binding (it runs `scheduled()`
 * instead), so this is a no-op there. Fire-and-forget: a fresh deployment, or
 * an alarm lost for any reason, is re-armed by the next request that finds the
 * throttle window open.
 */
export function armCelldTicker(env: Env, ctx: ExecutionContext, nowMs = Date.now()): void {
  if (!env.CRON_TICKER) return;
  if (nowMs - lastArmAttemptMs < TICK_INTERVAL_MS) return;
  lastArmAttemptMs = nowMs;
  const stub = env.CRON_TICKER.get(env.CRON_TICKER.idFromName(TICKER_INSTANCE_NAME));
  ctx.waitUntil(
    stub.arm().catch((error) => {
      // Reopen the window: a failed arm must not be throttled out for a full
      // interval, or a transient error costs a tick.
      lastArmAttemptMs = 0;
      log.warn("celld_ticker.arm_failed", { error: String(error) });
    }),
  );
}
