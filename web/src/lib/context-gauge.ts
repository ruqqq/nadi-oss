export interface ContextGauge {
  label: string;
  percent: number;
  tone: "normal" | "warning";
}

function compact(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * `null` means NOT TRACKED — a pre-feature thread, or one that never ran a turn.
 * The caller renders "Not tracked". It must never render 0: a thread that has
 * not been measured has not used zero tokens.
 *
 * The warning tone fires at the thread's REAL compaction trigger, which the
 * server persists per turn (`lastCompactAfterTokens`). It is deliberately NOT
 * re-derived here: the trigger is ~59% of the window, not 80% of it, and the
 * formula lives in `src/agent/context-budget.ts`. A copy of that arithmetic in
 * the UI would drift from it — and a threshold that drifts high is a bar that
 * never warns. When the server didn't record one, show no warning rather than
 * invent a threshold.
 */
export function formatContextGauge(
  tokens: number | null | undefined,
  window: number | null | undefined,
  compactAfterTokens?: number | null | undefined,
): ContextGauge | null {
  if (typeof tokens !== "number" || typeof window !== "number") return null;
  if (window <= 0) return null;

  const ratio = Math.min(tokens / window, 1);
  const percent = Math.round(ratio * 100);
  const warns =
    typeof compactAfterTokens === "number" &&
    compactAfterTokens > 0 &&
    tokens >= compactAfterTokens;
  return {
    label: `${compact(tokens)} / ${compact(window)} · ${percent}%`,
    percent,
    tone: warns ? "warning" : "normal",
  };
}
