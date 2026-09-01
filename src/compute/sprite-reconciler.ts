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

/**
 * Explicit page size for the provider listing, because the DEFAULT is unknown.
 *
 * `listSprites()` with no `max_results` leaves the page size to the provider,
 * and the client has no cursor handling at all — so a default smaller than the
 * account's sprite count silently hides strands from the only thing that
 * collects them, and the WARN line that would report them never appears. An
 * explicit bound at least makes truncation DETECTABLE (a full page is
 * suspicious), which is what {@link reconcileOrphanSprites} logs on.
 *
 * NOT a cursor implementation. Adding one means knowing the real response's
 * pagination shape, which this environment cannot observe — see the live-smoke
 * list. Raise it, or paginate properly, once the API's behaviour is known.
 */
export const LIST_SPRITES_MAX_RESULTS = 1000;

export interface SpriteReconcileResult {
  scanned: number;
  orphans: number;
  deleted: number;
  staleAcquiring: number;
  skipped?: "no_system_key" | "acquire_in_flight";
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
 * 2. **A row means keep, in EVERY status.** `idle` is a hibernated box with its
 *    disk intact; a DISABLED agent's box is `idle` and is live and intentional,
 *    not an orphan. Only the absence of a row is evidence.
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
  options: { client?: SpritesClient; now?: () => number } = {},
): Promise<SpriteReconcileResult> {
  const apiKey = env.SPRITES_API_KEY?.trim();
  const client = options.client ?? (apiKey ? createSpritesClient({ apiKey }) : null);
  if (!client)
    return { scanned: 0, orphans: 0, deleted: 0, staleAcquiring: 0, skipped: "no_system_key" };

  const now = (options.now ?? (() => Date.now()))();
  const ledger = new AgentSandboxLedger(registryBinding(env));

  // FIRST, so a permanently wedged acquire cannot pin guard 3 open forever.
  const staleAcquiring = await ledger.clearStaleAcquiring(now - ACQUIRE_GRACE_MS);

  const inFlight = await ledger.countAcquiringSince(now - ACQUIRE_GRACE_MS);
  if (inFlight > 0) {
    log.info("compute.sprite_reconcile_deferred", { acquiring: inFlight, staleAcquiring });
    return { scanned: 0, orphans: 0, deleted: 0, staleAcquiring, skipped: "acquire_in_flight" };
  }

  const known = await ledger.listKnownSpriteNames();
  const { names } = await client.listSprites(LIST_SPRITES_MAX_RESULTS);
  // A TRUNCATED LISTING UNDER-REAPS; IT CANNOT OVER-REAP. `known` comes from
  // D1 unpaginated, so every name we DID see is still classified correctly —
  // the guards do not weaken. What a short page costs is strands we never look
  // at, and since this is now the only collector those bill forever with
  // nothing to show for it. So reap what we saw, and say plainly that the
  // answer was incomplete rather than reporting a clean pass.
  const truncated = names.length >= LIST_SPRITES_MAX_RESULTS;
  if (truncated) {
    log.warn("compute.sprite_reconcile_truncated", {
      returned: names.length,
      maxResults: LIST_SPRITES_MAX_RESULTS,
    });
  }
  const orphans = names.filter(
    (name) => name.startsWith(RECONCILABLE_SPRITE_PREFIX) && !known.has(name),
  );

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
