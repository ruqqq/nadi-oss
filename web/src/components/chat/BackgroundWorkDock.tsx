import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Cpu, CheckCircle, XCircle, Clock } from "@/icons";
import type {
  BackgroundWorkKind,
  BackgroundWorkOutcome,
  BackgroundWorkReason,
} from "@/lib/use-background-work";

export interface BackgroundWorkDockRow {
  id: string;
  kind: BackgroundWorkKind;
  label: string | null;
  startedAt: number;
  terminal: { outcome: BackgroundWorkOutcome; reason: BackgroundWorkReason } | null;
}

type Tone = "running" | "success" | "warning" | "error";

/** Terminal outcome -> visual tone. `exited` is the only clean ending; every
 *  other terminal (`stopped`, `timeout`, `fault`) is something the model was
 *  told about because it was NOT what the caller asked for. */
function toneFor(terminal: BackgroundWorkDockRow["terminal"]): Tone {
  if (!terminal) return "running";
  switch (terminal.outcome) {
    case "exited":
      return "success";
    case "fault":
      return "error";
    default:
      return "warning"; // stopped | timeout
  }
}

const toneBorder: Record<Tone, string> = {
  running: "border-blue-500/30",
  success: "border-green-500/30",
  warning: "border-orange-500/40",
  error: "border-red-500/40",
};

const outcomeLabel: Record<BackgroundWorkOutcome, string> = {
  exited: "Exited",
  stopped: "Stopped",
  timeout: "Timed out",
  fault: "Faulted",
};

const reasonLabel: Record<BackgroundWorkReason, string> = {
  process_exit: "process exited",
  process_stopped: "stopped",
  watch_timeout: "watch window elapsed",
  sandbox_reset: "sandbox reset",
  no_liveness: "no liveness observed",
};

function ToneGlyph({ tone }: { tone: Tone }) {
  if (tone === "running") return <Clock className="size-3.5 text-blue-600" />;
  if (tone === "success") return <CheckCircle className="size-3.5 text-green-600" weight="fill" />;
  return (
    <XCircle
      className={`size-3.5 ${tone === "error" ? "text-red-600" : "text-orange-600"}`}
      weight="fill"
    />
  );
}

function statusText(row: BackgroundWorkDockRow): string {
  if (!row.terminal) return "Running";
  const label = outcomeLabel[row.terminal.outcome];
  const reason = row.terminal.reason ? reasonLabel[row.terminal.reason] : undefined;
  return reason ? `${label} · ${reason}` : label;
}

/** One row's chip, plus a drill-in with the raw ledger facts — the id and
 *  reason an incident needs and the chip has no room for. */
function BackgroundWorkRowChip({ row }: { row: BackgroundWorkDockRow }) {
  const [open, setOpen] = useState(false);
  const tone = toneFor(row.terminal);
  const title = row.label ?? row.id;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          data-testid={`bg-${row.id}`}
          data-outcome={row.terminal?.outcome ?? "running"}
          data-kind={row.kind}
          title={`${title} · ${statusText(row)}`}
          className={`flex flex-none items-center gap-2 rounded-md border bg-card px-2.5 py-1.5 text-xs shadow-sm transition hover:border-primary/40 ${toneBorder[tone]}`}
        >
          <ToneGlyph tone={tone} />
          <span className="max-w-[9rem] truncate font-medium">{title}</span>
          <span className="max-w-[8rem] truncate text-muted-foreground">{statusText(row)}</span>
        </button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <ToneGlyph tone={tone} />
            {title}
          </DialogTitle>
        </DialogHeader>
        <Card className="gap-2 p-4">
          <CardContent className="grid gap-1 p-0 text-sm">
            <div>
              <span className="text-muted-foreground">Kind</span> · {row.kind}
            </div>
            <div>
              <span className="text-muted-foreground">Status</span> · {statusText(row)}
            </div>
            <div className="break-all">
              <span className="text-muted-foreground">Id</span> · {row.id}
            </div>
            <div>
              <span className="text-muted-foreground">Started</span> ·{" "}
              {new Date(row.startedAt).toLocaleTimeString()}
            </div>
          </CardContent>
        </Card>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A slim strip pinned above the composer surfacing the thread's background
 * work — replaces the old `WatcherDock` (compute's `sandbox_process_watchers`
 * view, processes only) and `SubagentDock` (the ledger's subagent rows via a
 * live SDK event stream). Both read a store that cannot show a terminal
 * outcome for the OTHER kind; this dock reads the ledger directly
 * (`listBackgroundWork`), which already carries one outcome vocabulary for
 * both kinds. Renders nothing when there are no rows or the feature is
 * disabled, so it costs no space at rest.
 */
export function BackgroundWorkDock({
  enabled,
  rows,
}: {
  enabled: boolean;
  rows: BackgroundWorkDockRow[];
}) {
  if (!enabled || rows.length === 0) return null;

  const runningCount = rows.filter((row) => row.terminal === null).length;
  const doneCount = rows.length - runningCount;
  const summary =
    [
      runningCount > 0 ? `${runningCount} running` : null,
      doneCount > 0 ? `${doneCount} done` : null,
    ]
      .filter(Boolean)
      .join(" · ") || String(rows.length);

  return (
    <Card className="gap-1.5 rounded-none border-x-0 border-t border-b-0 bg-background/95 py-2.5 backdrop-blur">
      <CardHeader className="grid-rows-1 px-3">
        <CardTitle className="flex items-center gap-1.5 font-medium text-foreground text-xs">
          <Cpu className="size-3.5 text-muted-foreground" />
          Background work
          <span className="font-normal text-muted-foreground">· {summary}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="-mx-3 flex gap-2 overflow-x-auto px-3 pb-0.5">
        {rows.map((row) => (
          <BackgroundWorkRowChip key={row.id} row={row} />
        ))}
      </CardContent>
    </Card>
  );
}
