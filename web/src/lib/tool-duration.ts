/**
 * How long a tool call took, read off the persisted message part.
 *
 * The server stamps `durationMs` onto the part in `appendMessageToHistory` /
 * `updateMessageInHistory`, so it arrives through every history path — live,
 * archived, and paginated — with no extra request. Parts written before the
 * feature carry nothing, which is normal and renders as nothing at all.
 */

/** Below this, a duration is noise rather than information. */
const MIN_VISIBLE_MS = 1_000;

export function getToolDurationMs(part: unknown): number | undefined {
  const value = (part as { durationMs?: unknown } | undefined)?.durationMs;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

/**
 * A compact, human duration: `2.6s`, `45s`, `4m 12s`, `1h 3m`.
 *
 * Returns `undefined` under a second. Every tool call has some latency, and
 * labelling the fast ones buys nothing while adding a number to every row —
 * the point of showing this at all is to make a slow call obvious.
 */
export function formatToolDuration(durationMs: number | undefined): string | undefined {
  if (durationMs === undefined || durationMs < MIN_VISIBLE_MS) return undefined;
  const totalSeconds = Math.round(durationMs / 1_000);
  if (totalSeconds < 10) return `${(durationMs / 1_000).toFixed(1)}s`;
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainderMinutes = minutes % 60;
  return remainderMinutes === 0 ? `${hours}h` : `${hours}h ${remainderMinutes}m`;
}
