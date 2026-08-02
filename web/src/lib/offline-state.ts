/**
 * Pure offline decision logic. React glue lives in use-offline.tsx; keeping the
 * decisions pure makes them unit-testable in the node env (same split as
 * connection-recovery.ts / use-connection-recovery.ts).
 */

/** Thrown by appFetch when a mutation is attempted offline. Offline is strictly
 *  read-only: we never queue writes against a cached view of a workspace an
 *  agent may be concurrently changing. */
export class OfflineError extends Error {
  constructor() {
    super("You're offline. Reconnect to make changes.");
    this.name = "OfflineError";
  }
}

export function isOfflineError(error: unknown): error is OfflineError {
  return error instanceof OfflineError;
}

export function networkIsOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine;
}

/**
 * Did this failure mean "the server was unreachable"? A `fetch` rejection is a
 * TypeError; anything produced by errorFromResponse means the server DID reply
 * and is therefore not an offline signal.
 */
export function isNetworkFailure(error: unknown): boolean {
  return isOfflineError(error) || error instanceof TypeError;
}

/**
 * What the last bootstrap probe proved about the server. `"unknown"` means no
 * probe has resolved since the last known disconnect.
 */
export type Reachability = "unknown" | "reachable" | "unreachable";

/**
 * A resolved probe outranks `navigator.onLine` in BOTH directions — the browser
 * flag is a hint, a probe is evidence. Do not "simplify" this back to
 * `!browserOnline || unreachable`: if the `online` event is missed (it is not
 * guaranteed), `navigator.onLine` stays stale `false` forever, and OR-ing it in
 * latches the app offline no matter how many probes succeed. That latch is the
 * bug this shape exists to prevent.
 *
 * The converse still holds: `navigator.onLine` reports `true` on a connected-
 * but-dead network (captive portal, dead uplink), so a failed probe flips us
 * offline on its own. Only with no evidence do we fall back to the hint.
 */
export function resolveOffline({
  browserOnline,
  reachability,
}: {
  browserOnline: boolean;
  reachability: Reachability;
}): boolean {
  if (reachability === "reachable") return false;
  if (reachability === "unreachable") return true;
  return !browserOnline;
}
