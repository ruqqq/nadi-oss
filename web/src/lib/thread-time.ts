/**
 * Timestamp formatting for the thread detail view. Pure and now-injected so the
 * relative output is testable without mocking the clock.
 */

const EN_DASH = "—";

export function formatAbsoluteDate(ms: number): string {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return EN_DASH;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Compact "just now / 5m ago / 3h ago / 2d ago / 4w ago", falling back to an absolute date. */
export function formatRelativeTime(ms: number, nowMs: number): string {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return EN_DASH;

  const diffSec = Math.round((nowMs - ms) / 1000);
  if (diffSec < 45) return "just now";

  const min = Math.round(diffSec / 60);
  if (min < 60) return `${min}m ago`;

  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;

  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;

  const wk = Math.round(day / 7);
  if (wk < 5) return `${wk}w ago`;

  return formatAbsoluteDate(ms);
}

/** "Jul 8, 2026 · 2h ago" — absolute date with a relative suffix. */
export function formatCreatedAt(ms: number, nowMs: number): string {
  const absolute = formatAbsoluteDate(ms);
  if (absolute === EN_DASH) return EN_DASH;
  return `${absolute} · ${formatRelativeTime(ms, nowMs)}`;
}
