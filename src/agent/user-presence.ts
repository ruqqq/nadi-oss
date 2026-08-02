/**
 * The presence predicates behind UserHub, kept out of the Durable Object so they
 * are plain functions over plain data — the DO module imports
 * `cloudflare:workers` and cannot be loaded by the unit project.
 *
 * Two predicates, deliberately NOT one:
 *
 *  - `hasFreshVisibleThreadPresence` — "is this user looking at THIS thread".
 *    Drives unread state: a thread you were not looking at must still be marked
 *    unread when it finishes.
 *  - `hasFreshVisiblePresence` — "is this user using the app at all". Drives
 *    push suppression: an OS notification for someone who is already in the app
 *    is noise at best, and on an installed iOS PWA it is worse than noise —
 *    WebKit does not fire `notificationclick` while the app is running, so the
 *    banner is not even tappable.
 *
 * Collapsing them into one would silently cost the unread badge for every
 * thread the user is not currently reading.
 */

export type PresenceAttachment = {
  activeThreadId: string | null;
  /** The tab is on screen. Says nothing about whether anyone is in front of it. */
  visible: boolean;
  /**
   * Visible AND recently interacted with. Absent from clients built before this
   * existed, which fall back to `visible` — the behaviour they already had.
   */
  active?: boolean;
  updatedAt: number;
};

/**
 * How long a presence heartbeat stays trustworthy. The client re-sends every
 * 30s (see App.tsx), so this tolerates one missed beat and no more: a socket the
 * runtime has not yet torn down — a slept phone, dead wifi — must read as away
 * rather than suppress a notification that then reaches nobody.
 */
export const PRESENCE_FRESHNESS_MS = 45_000;

function isFresh(
  presence: PresenceAttachment | undefined,
  now: number,
): presence is PresenceAttachment {
  return presence?.visible === true && now - presence.updatedAt <= PRESENCE_FRESHNESS_MS;
}

/**
 * Is anyone actually AT one of this user's clients right now?
 *
 * Not the same question as `visible`, and the difference is the whole point: a
 * tab left frontmost on a desk stays visible indefinitely and would suppress
 * every notification for as long as it sat there. A phone resolves itself —
 * locking the screen hides the page and stops its timers — but a desktop with
 * the screen on does not, so the client reports interaction as well.
 *
 * Falls back to `visible` when a client does not report `active`, which is the
 * behaviour those builds already had rather than a sudden burst of pushes.
 */
export function hasFreshVisiblePresence(
  presences: Array<PresenceAttachment | undefined>,
  now: number,
): boolean {
  return presences.some(
    (presence) => isFresh(presence, now) && (presence.active ?? presence.visible),
  );
}

/** Is any of this user's clients visible AND showing `threadId`? */
export function hasFreshVisibleThreadPresence(
  presences: Array<PresenceAttachment | undefined>,
  threadId: string,
  now: number,
): boolean {
  return presences.some(
    (presence) => isFresh(presence, now) && presence.activeThreadId === threadId,
  );
}
