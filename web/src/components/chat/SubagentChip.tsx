import { useState } from "react";
import type { UIMessage } from "ai";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { useMediaQuery } from "@/lib/use-media-query";
import type { ToolNameServer } from "@/lib/resolve-tool-name";
import {
  runDurationLabel,
  subagentCardModel,
  type SubagentRunView,
  type SubagentTone,
} from "@/lib/subagent-runs";
import { CheckCircle, XCircle } from "@/icons";
import { SubagentTranscript } from "./SubagentTranscript";

/** Per-tone border tint for the chip; the glyph carries the status colour. */
const toneBorder: Record<SubagentTone, string> = {
  running: "border-blue-500/30",
  success: "border-green-500/30",
  error: "border-red-500/40",
  stopped: "border-orange-500/40",
};

function ToneGlyph({ tone, isRunning }: { tone: SubagentTone; isRunning: boolean }) {
  if (isRunning) return <Spinner className="size-3.5 text-blue-600" label="running" />;
  if (tone === "success") return <CheckCircle className="size-3.5 text-green-600" weight="fill" />;
  return (
    <XCircle
      className={`size-3.5 ${tone === "error" ? "text-red-600" : "text-orange-600"}`}
      weight="fill"
    />
  );
}

/**
 * A compact subagent run in the dock. Tap opens a drill-in (Sheet on mobile,
 * Dialog on desktop) with the child transcript and a Cancel control while it
 * runs. `nowMs` is supplied by the dock's shared 1s ticker so all chips advance
 * their duration together; `timing` is the run's server-persisted start/finish
 * (survives a page refresh, unlike a client-side first-seen timestamp).
 */
export function SubagentChip({
  run,
  timing,
  nowMs,
  servers,
  onCancel,
}: {
  run: SubagentRunView & { parts?: UIMessage["parts"] };
  timing?: { startedAt?: number; finishedAt?: number };
  nowMs: number;
  servers: ToolNameServer[];
  onCancel: () => void;
}) {
  const [open, setOpen] = useState(false);
  const isMobile = useMediaQuery("(max-width: 640px)");
  const model = subagentCardModel(run, { nowMs });
  // Live while running (frozen at `finishedAt` once the run is terminal) —
  // see `runDurationLabel`'s docstring for why this beats a client-side
  // first-seen timestamp.
  const durationLabel = runDurationLabel({
    ...(timing?.startedAt !== undefined ? { startedAt: timing.startedAt } : {}),
    ...(timing?.finishedAt !== undefined ? { finishedAt: timing.finishedAt } : {}),
    nowMs,
  });

  const chip = (
    <button
      type="button"
      title={[model.title, model.isRunning ? model.progressLine : model.statusLabel, durationLabel]
        .filter(Boolean)
        .join(" · ")}
      className={`flex flex-none items-center gap-2 rounded-md border bg-card px-2.5 py-1.5 text-xs shadow-sm transition hover:border-primary/40 ${toneBorder[model.tone]}`}
    >
      <ToneGlyph tone={model.tone} isRunning={model.isRunning} />
      <span className="max-w-[9rem] truncate font-medium">{model.title}</span>
      {model.isRunning ? (
        model.progressLine && (
          <span className="max-w-[8rem] truncate text-muted-foreground">{model.progressLine}</span>
        )
      ) : (
        <span className="max-w-[8rem] truncate text-muted-foreground">{model.statusLabel}</span>
      )}
      {durationLabel && <span className="tabular-nums text-muted-foreground">{durationLabel}</span>}
    </button>
  );

  // Status flows left, right after the title, so it never collides with the
  // Sheet/Dialog close (✕); the header reserves right padding for that button.
  const header = (
    <span className="flex min-w-0 items-center gap-2">
      <ToneGlyph tone={model.tone} isRunning={model.isRunning} />
      <span className="truncate">{model.title}</span>
      <span className="flex-none font-normal text-muted-foreground text-sm">
        · {model.statusLabel}
        {durationLabel ? ` · ${durationLabel}` : ""}
      </span>
    </span>
  );

  const detail = (
    <div className="min-h-0 flex-auto overflow-y-auto p-4">
      {model.isRunning && (
        <div className="mb-4 flex items-center justify-between gap-3">
          {model.progressLine && (
            <span className="min-w-0 truncate text-muted-foreground text-xs">
              {model.progressLine}
            </span>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="flex-none"
            onClick={onCancel}
          >
            Cancel run
          </Button>
        </div>
      )}
      <SubagentTranscript parts={run.parts} servers={servers} isRunning={model.isRunning} />
    </div>
  );

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>{chip}</SheetTrigger>
        <SheetContent side="bottom" className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0">
          <SheetHeader className="shrink-0 border-b py-4 pr-12 pl-5">
            <SheetTitle className="text-base">{header}</SheetTitle>
          </SheetHeader>
          {detail}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{chip}</DialogTrigger>
      <DialogContent className="flex max-h-[82vh] flex-col gap-0 p-0 sm:max-w-xl">
        <DialogHeader className="shrink-0 border-b py-4 pr-12 pl-5">
          <DialogTitle className="text-base">{header}</DialogTitle>
        </DialogHeader>
        {detail}
      </DialogContent>
    </Dialog>
  );
}
