import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { useMediaQuery } from "@/lib/use-media-query";
import { watcherCardModel, type ActiveWatcher } from "@/lib/watcher-runs";

export function WatcherChip({ watcher, nowMs }: { watcher: ActiveWatcher; nowMs: number }) {
  const [open, setOpen] = useState(false);
  const isMobile = useMediaQuery("(max-width: 640px)");
  const model = watcherCardModel(watcher, { nowMs });
  const outputTail = watcher.outputTail ?? "";
  const hasOutput = outputTail.trim().length > 0;
  const outputRef = useRef<HTMLDivElement>(null);

  // Keep the newest output in view as each poll refreshes the tail.
  useEffect(() => {
    const el = outputRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [outputTail]);

  const chip = (
    <button
      type="button"
      title={`${model.title} · ${model.elapsedLabel}`}
      className="flex flex-none items-center gap-2 rounded-md border border-blue-500/30 bg-card px-2.5 py-1.5 text-xs shadow-sm transition hover:border-primary/40"
    >
      <Spinner className="size-3.5 text-blue-600" label="watching" />
      <span className="max-w-[9rem] truncate font-medium">{model.title}</span>
      <span className="tabular-nums text-muted-foreground">{model.elapsedLabel}</span>
    </button>
  );

  const header = (
    <span className="flex min-w-0 items-center gap-2">
      <Spinner className="size-3.5 text-blue-600" label="watching" />
      <span className="truncate">{model.title}</span>
    </span>
  );

  const detail = (
    <div className="min-h-0 flex-auto space-y-2 overflow-y-auto p-4 text-sm">
      <div>
        <div className="text-muted-foreground text-xs">Command</div>
        <div className="break-all font-mono text-xs">{model.subtitle}</div>
      </div>
      <div className="flex gap-6">
        <div>
          <div className="text-muted-foreground text-xs">Process</div>
          <div className="font-mono text-xs">{model.shortId}</div>
        </div>
        <div>
          <div className="text-muted-foreground text-xs">Elapsed</div>
          <div className="tabular-nums text-xs">{model.elapsedLabel}</div>
        </div>
        <div>
          <div className="text-muted-foreground text-xs">Notify by</div>
          <div className="text-xs">{model.expectedLabel}</div>
        </div>
      </div>
      <div>
        <div className="text-muted-foreground text-xs">Output</div>
        <div
          ref={outputRef}
          className={cn(
            "mt-1 max-h-48 overflow-y-auto rounded-md border border-border bg-muted/30 p-2",
            "whitespace-pre-wrap break-all font-mono text-xs",
          )}
        >
          {hasOutput ? outputTail : <span className="text-muted-foreground">(waiting for output…)</span>}
        </div>
      </div>
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
