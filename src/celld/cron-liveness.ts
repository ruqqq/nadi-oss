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
 * Written only where the registry has no dashboard behind it, which is celld.
 * Both platforms bind the same stores now, so the marker is gated on
 * NADI_PLATFORM rather than on a binding: a binding used as a platform
 * predicate is exactly the mistake this gate exists to prevent. A stamp must
 * never fail the run it is reporting on, so every write here is best-effort.
 *
 * These live in the secrets KV namespace under a `system/` prefix, which is
 * where they lived when that namespace was a table. It is a shared namespace,
 * not a secret one — the workspace secret keys are all `workspaces/<id>/…`, so
 * the two prefixes cannot collide, and a `list` for either one cannot see the
 * other.
 */

import type { Env } from "../env";
import { log } from "../log";

/** Set on every `scheduled()` invocation, whichever expression fired. */
export const CRON_LAST_TICK_KEY = "system/celld-ticker/last-tick";

/** Set when the daily sweep expression (`0 3 * * *`) completes. */
export const CRON_LAST_DAILY_RUN_KEY = "system/celld-ticker/last-daily-run";

/** Whether this deployment is the one with no cron dashboard to consult. */
export function isCelld(env: Pick<Env, "NADI_PLATFORM">): boolean {
  return env.NADI_PLATFORM === "celld";
}

/**
 * Best-effort liveness stamp. No-op off celld, and a throw is logged rather
 * than propagated — a marker that cannot be written must not take down the
 * automata run or the daily sweep that just succeeded.
 */
export async function stampCronRun(env: Env, key: string, atMs: number): Promise<void> {
  if (!isCelld(env) || !env.SECRETS_KV) return;
  try {
    await env.SECRETS_KV.put(key, String(atMs));
  } catch (error) {
    log.warn("celld_cron.marker_failed", { key, error: String(error) });
  }
}
