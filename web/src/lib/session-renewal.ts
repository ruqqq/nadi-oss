import { getSession as defaultGetSession } from "../auth-api";
import type { AuthSession } from "../auth-api";

const RENEWED_AT_KEY = "nadi.session.renewedAt";

/**
 * Deliberately below the server's 1-day `updateAge` (see `src/auth/options.ts`).
 * Better Auth only extends a session once it is actually due, so pings inside
 * that day cost a read and write nothing — while a client that wakes up every
 * 12 hours can never drift past the day and let a session lapse untouched.
 */
export const RENEW_AFTER_MS = 12 * 60 * 60 * 1000;

export interface SessionRenewalDeps {
  getSession: () => Promise<AuthSession>;
  now: () => number;
  storage: Pick<Storage, "getItem" | "setItem">;
}

function readRenewedAt(storage: SessionRenewalDeps["storage"]): number | null {
  try {
    const raw = storage.getItem(RENEWED_AT_KEY);
    if (raw === null) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Roll the session forward. `/api/auth/get-session` is the only route that runs
 * Better Auth's refresh — every other authenticated call reads the session with
 * `disableRefresh`, so without this ping a session silently expires under an
 * active user.
 *
 * Never throws and never touches auth state: it either extends the session or
 * does nothing. Deciding that a session is gone belongs to the bootstrap probe.
 */
export async function maybeRenewSession(deps?: Partial<SessionRenewalDeps>): Promise<void> {
  const getSession = deps?.getSession ?? defaultGetSession;
  const now = deps?.now ?? Date.now;
  const storage = deps?.storage ?? globalThis.localStorage;

  const renewedAt = readRenewedAt(storage);
  if (renewedAt !== null && now() - renewedAt < RENEW_AFTER_MS) return;

  try {
    const session = await getSession();
    // Only a renewal the server honored is worth remembering; anything else must
    // be retried on the next launch.
    if (!session.authenticated) return;
    storage.setItem(RENEWED_AT_KEY, String(now()));
  } catch {
    // Offline, or the server refused. Leave the stamp untouched so the next
    // launch tries again.
  }
}
