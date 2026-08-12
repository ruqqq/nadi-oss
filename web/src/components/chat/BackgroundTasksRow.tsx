import { CaretRight, CheckCircle, Clock, WarningCircle } from "@/icons";
import type { BackgroundWorkRow } from "@/lib/use-background-work";

type IndicatorState = "running" | "failed" | "clean";

function isRunning(row: BackgroundWorkRow): boolean {
  return row.terminal === null;
}

/** A row counts as "clean" only on a confirmed zero exit. Everything else
 * terminal — a non-zero exit, an unknown exit code, or a non-`exited`
 * outcome (`stopped` | `timeout` | `fault`) — falls into "failed" here. This
 * collapsed summary has only three buckets to work with, and the one thing
 * it must never do is fold an unconfirmed exit into "clean" (see
 * `BackgroundTasksSheet`, which draws the finer "unknown" distinction the
 * dock row has no room for). */
function isClean(row: BackgroundWorkRow): boolean {
  return row.terminal !== null && row.terminal.outcome === "exited" && row.terminal.exitCode === 0;
}

function isFailed(row: BackgroundWorkRow): boolean {
  return row.terminal !== null && !isClean(row);
}

function summarize(rows: BackgroundWorkRow[]): string {
  const running = rows.filter(isRunning).length;
  const failed = rows.filter(isFailed).length;
  const clean = rows.filter(isClean).length;
  return [
    running > 0 ? `${running} running` : null,
    failed > 0 ? `${failed} failed` : null,
    clean > 0 ? `${clean} clean` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

function indicatorState(rows: BackgroundWorkRow[]): IndicatorState {
  if (rows.some(isRunning)) return "running";
  if (rows.some(isFailed)) return "failed";
  return "clean";
}

const INDICATOR_TONE: Record<IndicatorState, string> = {
  running: "text-steer",
  failed: "text-reject",
  clean: "text-approve",
};

function Indicator({ state }: { state: IndicatorState }) {
  const Icon = state === "running" ? Clock : state === "failed" ? WarningCircle : CheckCircle;
  return (
    <Icon
      data-testid="bg-indicator"
      data-state={state}
      aria-hidden
      weight={state === "running" ? "regular" : "fill"}
      className={`size-4 shrink-0 ${INDICATOR_TONE[state]}`}
    />
  );
}

/**
 * Collapsed dock row above the composer. Replaced the now-deleted
 * `BackgroundWorkDock`'s per-task chip strip with one summary row
 * (`QueuedMessageStrip` chrome), because the chip strip named every task in
 * the composer's peripheral vision even when nothing needed attention. No
 * PER-TASK labels here on purpose: the state-mix summary answers "does
 * anything need me" at a glance, and the sheet (`BackgroundTasksSheet`) is
 * where an individual task gets named. The row itself IS labelled
 * ("Background tasks"), though — a summary with no name for what it's
 * summarizing has no accessible name for the button that opens it.
 */
export function BackgroundTasksRow({
  enabled,
  rows,
  onOpen,
}: {
  enabled: boolean;
  rows: BackgroundWorkRow[];
  onOpen: () => void;
}) {
  if (!enabled || rows.length === 0) return null;

  const state = indicatorState(rows);
  const summary = summarize(rows);

  return (
    <div className="border-t border-border bg-background/95 px-3 py-2">
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={onOpen}
        className="flex w-full min-w-0 items-center gap-2 rounded-md border border-border bg-muted/30 px-2 py-1.5 text-sm transition hover:border-primary/40"
      >
        <Indicator state={state} />
        <span className="min-w-0 flex-1 truncate text-left">
          <span className="font-medium text-foreground">Background tasks</span>
          {summary && (
            <>
              <span className="text-muted-foreground"> · </span>
              <span className="text-muted-foreground">{summary}</span>
            </>
          )}
        </span>
        <CaretRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      </button>
    </div>
  );
}
