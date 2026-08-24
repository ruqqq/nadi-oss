/**
 * celld-only liveness markers for the `scheduled()` cron.
 *
 * celld v0.3.0 runs cron triggers natively — durably, once per occurrence
 * fleet-wide, with retries and one missed run recovered after downtime — so
 * the per-minute `CelldTicker` Durable Object that used to stand in for
 * Cloudflare's cron is gone. What is kept from it is the observability: the
 * ticker existed because scheduled work failing SILENTLY is the expensive
 * failure, and "did cron run?" is still worth being able to answer from
 * outside the process. `/api/debug/celld-ticker` reads these.
 *
 * Written only where `REGISTRY_DO` exists, which is celld — Cloudflare's
 * registry is the `REGISTRY_DB` D1 binding and its cron is Cloudflare's own,
 * observable in the dashboard. A stamp must never fail the run it is
 * reporting on, so every write here is best-effort.
 *
 * The key strings are deliberately the ones `CelldTicker` wrote, so a
 * deployment upgraded from the ticker keeps reading its existing markers
 * instead of showing null until the next occurrence.
 */

import type { RegistryDatabase } from "../db/registry-do";
import { RegistryKV } from "../db/registry-kv";
import { log } from "../log";

/** Set on every `scheduled()` invocation, whichever expression fired. */
export const CRON_LAST_TICK_KEY = "system/celld-ticker/last-tick";

/** Set when the daily sweep expression (`0 3 * * *`) completes. */
export const CRON_LAST_DAILY_RUN_KEY = "system/celld-ticker/last-daily-run";

/**
 * Best-effort liveness stamp. No-op off celld (no `REGISTRY_DO`), and a throw
 * is logged rather than propagated — a marker that cannot be written must not
 * take down the automata run or the daily sweep that just succeeded.
 */
export async function stampCronRun(
  env: { REGISTRY_DO?: DurableObjectNamespace<RegistryDatabase> },
  key: string,
  atMs: number,
): Promise<void> {
  if (!env.REGISTRY_DO) return;
  try {
    await new RegistryKV(env.REGISTRY_DO).put(key, String(atMs));
  } catch (error) {
    log.warn("celld_cron.marker_failed", { key, error: String(error) });
  }
}
