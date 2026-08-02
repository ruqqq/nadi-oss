import { useEffect, useState } from "react";
import type { ToolNameServer } from "@/lib/resolve-tool-name";
import type { SubagentRunsState } from "@/lib/use-subagent-runs";
import { Cpu, Trash } from "@/icons";
import { SubagentChip } from "./SubagentChip";

/**
 * A slim "mission control" strip pinned just above the composer that surfaces
 * the thread's subagent runs — glanceable status while work runs, drill-in and
 * cancel per run, and a clear-finished action. Renders nothing when there are no
 * (undismissed) runs, so it costs no vertical space at rest.
 */
export function SubagentDock({
  enabled,
  subagentRuns,
  servers,
}: {
  enabled: boolean;
  subagentRuns: SubagentRunsState;
  servers: ToolNameServer[];
}) {
  const { runs, runningCount, finishedCount, hasFinished, clearFinished, cancelRun, timings } =
    subagentRuns;
  const [nowMs, setNowMs] = useState(() => Date.now());
  const anyRunning = runningCount > 0;

  // One shared 1s ticker drives every chip's duration label while work runs.
  useEffect(() => {
    if (!enabled || !anyRunning) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [enabled, anyRunning]);

  if (!enabled || runs.length === 0) return null;

  const summary =
    [
      runningCount > 0 ? `${runningCount} running` : null,
      finishedCount > 0 ? `${finishedCount} done` : null,
    ]
      .filter(Boolean)
      .join(" · ") || String(runs.length);

  return (
    <div className="border-t bg-background/95 px-3 pt-2.5 pb-2 backdrop-blur">
      <div className="mb-2 flex items-center gap-1.5">
        <Cpu className="size-3.5 text-muted-foreground" />
        <span className="font-medium text-foreground text-xs">Subagents</span>
        <span className="text-muted-foreground text-xs">· {summary}</span>
        {hasFinished && (
          <button
            type="button"
            onClick={clearFinished}
            className="-mr-1 ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground text-xs transition hover:bg-muted hover:text-foreground"
          >
            <Trash className="size-3.5" />
            Clear finished
          </button>
        )}
      </div>
      <div className="-mx-3 flex gap-2 overflow-x-auto px-3 pb-0.5">
        {runs.map((run) => (
          <SubagentChip
            key={run.runId}
            run={run}
            timing={timings[run.runId]}
            nowMs={nowMs}
            servers={servers}
            onCancel={() => cancelRun(run.runId)}
          />
        ))}
      </div>
    </div>
  );
}
