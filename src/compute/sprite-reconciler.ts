import type { Env } from "../env";
import { registryBinding } from "../db/client";
import { AgentSandboxLedger } from "./agent-sandbox-ledger";
import { createSpritesClient, type SpritesClient } from "./backends/sprites-client";
import { RECONCILABLE_SPRITE_PREFIX } from "./backends/sprites";
import { log } from "../log";

/**
 * How long a row may sit in `acquiring` before the reconciler stops treating it
 * as evidence that an unnamed sprite is being provisioned.
 *
 * An `acquiring` row is the one state where a sprite may exist that the ledger
 * cannot NAME — the row is written before the provider is asked, and the name
 * is recorded when it answers. While such a row is fresh, ANY unknown sprite
 * might be the one it is creating, so no reap may run at all.
 *
 * Generous by an order of magnitude over a real acquire (`ACQUIRE_DEADLINE_MS`
 * is a couple of minutes at most). Being wrong long is a delayed reap; being
 * wrong short deletes a machine mid-creation.
 */
export const ACQUIRE_GRACE_MS = 30 * 60 * 1000;

export interface SpriteReconcileResult {
  scanned: number;
  orphans: number;
  deleted: number;
  staleAcquiring: number;
  /** True when the pass only REPORTED orphans. See `SPRITE_RECONCILER_DRY_RUN`. */
  dryRun?: boolean;
  skipped?: "no_system_key" | "acquire_in_flight";
}

/**
 * Opt-in log-only mode, read from `env.SPRITE_RECONCILER_DRY_RUN`.
 *
 * `"true"` enables it, matched case-insensitively after trimming. Anything
 * else — absent, empty, `"1"`, `"yes"` — reaps for real, which is the
 * deliberate direction: a mistyped flag must not silently disable the only
 * collector this phase has.
 */
export function parseSpriteReconcilerDryRun(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === "true";
}

/**
 * Delete sprites this deployment created and then lost track of.
 *
 * NOTHING auto-destroys a sprite any more, so a crashed acquire — the Worker
 * dying between `createSprite` and the row write — strands a machine that bills
 * forever with no code path left that can reach it. This is the only thing that
 * collects those. It is also what finally collects the box of an agent deleted
 * while a subagent held a lease, where `execShutdown` threw
 * `compute_children_active` and the route dropped the row anyway.
 *
 * THE THREE GUARDS, each of which alone would make this destroy live user data:
 *
 * 1. **Prefix.** Only names carrying {@link RECONCILABLE_SPRITE_PREFIX} are
 *    even considered. Sprites created before P3 have no `agent_sandboxes` row
 *    and nothing will ever backfill one — a hibernated box is not woken — so
 *    reaping every unknown `nadi-*` would delete every existing user's
 *    filesystem on this deploy's first cron.
 * 2. **A LIVE agent's row means keep, in EVERY status.** `idle` is a hibernated
 *    box with its disk intact; a DISABLED agent's box is `idle` and is live and
 *    intentional, not an orphan. The only narrowing is `archived_at IS NULL`
 *    (see `listKnownSpriteNames`), and it is a statement about intent rather
 *    than a scope: deleting an agent promises to delete its machine, and only
 *    the delete route sets that column — disable leaves it null. That is also
 *    what makes this the backstop for a delete whose own `remove()` failed.
 * 3. **No reap beside an in-flight acquire.** A row in `acquiring` may already
 *    own a sprite whose name was never recorded, and no query can say which
 *    one, so the whole pass stands down rather than guess. Stale `acquiring`
 *    rows are cleared first, so one wedged acquire cannot block reconciliation
 *    forever.
 *
 * **SYSTEM-MANAGED SPRITES ONLY**, deliberately. A BYOK workspace's key is the
 * customer's, its `listSprites` returns machines we did not create and have no
 * business enumerating, and a stranded BYOK sprite bills the customer rather
 * than the operator. Reaping across someone else's account is the higher-risk
 * direction, so it is not done. A BYOK strand is a known, stated gap.
 */
export async function reconcileOrphanSprites(
  env: Env,
  options: { client?: SpritesClient; now?: () => number; dryRun?: boolean } = {},
): Promise<SpriteReconcileResult> {
  const apiKey = env.SPRITES_API_KEY?.trim();
  const client = options.client ?? (apiKey ? createSpritesClient({ apiKey }) : null);
  if (!client)
    return { scanned: 0, orphans: 0, deleted: 0, staleAcquiring: 0, skipped: "no_system_key" };

  const now = (options.now ?? (() => Date.now()))();
  const dryRun = options.dryRun ?? parseSpriteReconcilerDryRun(env.SPRITE_RECONCILER_DRY_RUN);
  const ledger = new AgentSandboxLedger(registryBinding(env));

  // FIRST, so a permanently wedged acquire cannot pin guard 3 open forever.
  const staleAcquiring = await ledger.clearStaleAcquiring(now - ACQUIRE_GRACE_MS);

  const inFlight = await ledger.countAcquiringSince(now - ACQUIRE_GRACE_MS);
  if (inFlight > 0) {
    log.info("compute.sprite_reconcile_deferred", { acquiring: inFlight, staleAcquiring });
    return { scanned: 0, orphans: 0, deleted: 0, staleAcquiring, skipped: "acquire_in_flight" };
  }

  const known = await ledger.listKnownSpriteNames();
  // NO `max_results`, DELIBERATELY — and this is the SECOND answer to the same
  // question, because the first one was worse than the problem.
  //
  // A truncated listing UNDER-reaps and cannot over-reap: `known` comes from an
  // unpaginated D1 read, so every name we DID see is still classified
  // correctly and no guard weakens. What a short page costs is strands we never
  // look at, which — since this is now the only collector — bill forever with
  // nothing in the log to show it.
  //
  // Passing an explicit bound to make truncation DETECTABLE does not fix that,
  // and can make it worse. The check would be `names.length >= bound`, which
  // only fires if the provider HONOURS the bound; if its own page cap is lower,
  // the pass under-reaps in silence exactly as before and the warning the bound
  // exists to produce never appears. And an out-of-range value is a plausible
  // 400: `listSprites` throws, the daily cron catches it as a WARN, and THE
  // ONLY COLLECTOR STOPS RUNNING while the cron still reports success. The
  // no-argument call cannot do that. `listSprites(1)` is the only value this
  // provider has ever been observed to accept (`sprites-smoke.ts`), so a
  // 1000 here was an invention dressed as a safeguard.
  //
  // What is honest within this environment's limits: report `returned` on EVERY
  // pass, so an operator sees it plateau at whatever the real cap turns out to
  // be. The live smoke settles the pagination shape; see the report.
  const { names } = await client.listSprites();
  log.info("compute.sprite_reconcile_listed", { returned: names.length });

  // GUARD 3, SECOND HALF — and without it the first half misses by two
  // statements. A cold start that begins AFTER the `countAcquiringSince` above
  // writes its `acquiring` row too late to be counted, and creates its sprite
  // AFTER `known` was read — so the machine is in `names`, absent from `known`,
  // and gets deleted out from under a live turn. Re-checking here closes the
  // window: any acquire that touched the ledger at any point during this pass
  // aborts it. Deferring costs a day; reaping a machine mid-provision costs a
  // user's filesystem, and the whole pass is discretionary.
  //
  // AND THE COUNT ALONE IS NOT ENOUGH, which is why `known` is re-read below.
  // An acquire that wrote its `acquiring` row after the FIRST count and settled
  // to `active` before this one is invisible to both: its sprite is in `names`,
  // absent from the stale `known`, and nothing here has an age to judge it by.
  // One extra D1 read closes it; the union is what gets classified.
  const inFlightAfter = await ledger.countAcquiringSince(now - ACQUIRE_GRACE_MS);
  if (inFlightAfter > 0) {
    log.info("compute.sprite_reconcile_deferred", {
      acquiring: inFlightAfter,
      staleAcquiring,
      phase: "after_listing",
    });
    return {
      scanned: names.length,
      orphans: 0,
      deleted: 0,
      staleAcquiring,
      skipped: "acquire_in_flight",
    };
  }

  // THE UNION, not the second read alone: `known` was a superset-safe answer at
  // the time it was taken, and a row deleted between the two reads (an agent
  // deleted mid-pass) is one whose sprite the delete route already handled.
  // Keeping both readings can only ever SPARE more, which is the safe
  // direction — the unsafe one is classifying against a name set older than the
  // provider's answer.
  for (const name of await ledger.listKnownSpriteNames()) known.add(name);

  const orphans = names.filter(
    (name) => name.startsWith(RECONCILABLE_SPRITE_PREFIX) && !known.has(name),
  );

  // THE DRY RUN. Guard 1's premise — that no pre-P3 sprite carries
  // `RECONCILABLE_SPRITE_PREFIX` — is asserted against this repo's own code and
  // has never been checked against the real fleet, and the first cron after
  // deploy deletes on that assumption. One flag buys a log-only pass that names
  // every sprite it WOULD have destroyed, so the assumption can be read off
  // production before anything is irreversible. Default is OFF (a `true` string
  // opts in), because the flag's other setting must not be a way to silently
  // stop the only collector: a deployment that forgets to unset it sees a
  // steady `would_reap` line, not silence.
  if (dryRun) {
    for (const name of orphans) {
      log.warn("compute.sprite_orphan_would_reap", { spriteName: name });
    }
    return { scanned: names.length, orphans: orphans.length, deleted: 0, staleAcquiring, dryRun };
  }

  let deleted = 0;
  for (const name of orphans) {
    try {
      await client.deleteSprite(name);
      deleted += 1;
      // At WARN, not INFO. Every line here is a machine that existed with
      // nothing accounting for it; a run that reaps steadily is a bug report
      // about the acquire path, not routine housekeeping.
      log.warn("compute.sprite_orphan_reaped", { spriteName: name });
    } catch (error) {
      log.warn("compute.sprite_orphan_reap_failed", { spriteName: name, error: String(error) });
    }
  }

  return { scanned: names.length, orphans: orphans.length, deleted, staleAcquiring };
}
