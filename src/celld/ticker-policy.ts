/**
 * The celld ticker's pure decision layer: interval constants and the
 * "is the daily work due" rule.
 *
 * celld rejects the `triggers` config key and never invokes a `scheduled()`
 * handler, so a per-minute ticker Durable Object (see `ticker.ts`) stands in
 * for Cloudflare's cron. It re-arms itself every minute and calls the same
 * job functions `scheduled()` calls in `src/index.ts`, unchanged.
 *
 * Kept free of Workers imports (`cloudflare:*`, D1, `agents`) so it can be
 * unit tested under the node-based `unit` vitest project, mirroring
 * `src/automata/fire-policy.ts`.
 */

/**
 * The ticker wakes every minute — the same cadence as `AUTOMATA_CRON`
 * ("* * * * *") in `src/automata/fire-policy.ts`.
 *
 * Eviction coupling with the celld runtime: every tick touches the registry
 * cell (automata reads, the daily-due decision, the liveness marker), and
 * celld only replicates a cell once it has been idle for `CELLD_IDLE_EVICT_S`
 * (~15 s in the celld runtime). This interval must stay comfortably ABOVE
 * that threshold, or the registry never idles, never replicates, and an
 * unquiesced crash loses everything back to boot. At 60 s against a 15 s
 * threshold every tick leaves a ~45 s quiet window. Do not shorten the poll
 * interval without re-checking the celld eviction threshold.
 */
export const TICK_INTERVAL_MS = 60_000;

/**
 * The daily sweep (auto-archive of idle threads + stale search-projection
 * repair) runs about once a day — the cadence `AUTO_ARCHIVE_CRON`
 * ("0 3 * * *") gives on Cloudflare. "About", not exactly: the ticker checks
 * the registry marker each tick, so the sweep lands on whichever tick first
 * observes the marker older than this interval.
 */
export const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Singleton instance name for the ticker Durable Object. */
export const TICKER_INSTANCE_NAME = "ticker";

/**
 * Registry (`__celld_kv`) keys the ticker writes. The `system/` prefix sits
 * outside the `workspaces/<id>/secrets/` namespace the secrets store uses.
 */
export const TICKER_LAST_TICK_KEY = "system/celld-ticker/last-tick";
export const TICKER_LAST_DAILY_RUN_KEY = "system/celld-ticker/last-daily-run";

/**
 * "Is the daily work due?" — decided from registry state (when the jobs last
 * ran), never from a timestamp the ticker remembers. A per-minute ticker cell
 * never idles, and celld only replicates a cell on idle eviction, so
 * ticker-local state would be the least durable state in the system. The
 * marker lives in the registry, which replicates on idle eviction and is the
 * source of truth.
 *
 * `lastDailyRunMs` is the registry marker (epoch ms), or null when the daily
 * sweep has never completed — which is also due: a fresh or restored
 * deployment must catch up on the first tick.
 */
export function isDailyWorkDue(lastDailyRunMs: number | null, nowMs: number): boolean {
  if (lastDailyRunMs === null) return true;
  return nowMs - lastDailyRunMs >= DAILY_INTERVAL_MS;
}
