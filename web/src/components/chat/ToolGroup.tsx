import { useState } from "react";
import { getToolName, type ToolUIPart } from "ai";
import { formatToolDuration, getToolDurationMs } from "@/lib/tool-duration";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useMediaQuery } from "@/lib/use-media-query";
import { resolveToolName, type ToolNameServer } from "@/lib/resolve-tool-name";
import { buildToolLogEntry } from "@/lib/tool-log";
import { getRunToolLine, getSingleToolLine, type ToolLine } from "@/lib/tool-summary";
import { isActiveToolState } from "@/lib/tool-activity";
import { ActivityLine, type ActivityState } from "./ActivityLine";
import { ToolRunLog } from "./ToolRunLog";

export interface ToolGroupItem {
  key: string;
  part: ToolUIPart;
}

const isError = (state: ToolUIPart["state"]) =>
  state === "output-error" || state === "output-denied";

/**
 * One or more consecutive tool calls, rendered as a single recessed activity
 * line (see ActivityLine): a lone call shows its own verb-led phrase ("Edited
 * next.config.ts +12 −3"); a run of 2+ collapses by verb ("Ran 3 commands, read
 * 2 files, edited a file"). Success is silent; only a running/failed run gets a
 * hanging marker. Tapping it opens the run as one log (bottom Sheet on mobile,
 * centered Dialog on desktop): the header repeats the line that was tapped, and
 * every call renders as a kind gutter plus tool-shaped detail — see
 * lib/tool-log.ts, which owns all per-tool knowledge.
 * Presentation only — pending-approval calls never reach here.
 */
export function ToolGroup({
  items,
  servers,
}: {
  items: ToolGroupItem[];
  servers: ToolNameServer[];
}) {
  const [open, setOpen] = useState(false);
  const isMobile = useMediaQuery("(max-width: 640px)");

  const rows = items.map((it) => {
    const toolName = getToolName(it.part);
    const resolved = resolveToolName(toolName, servers);
    return {
      key: it.key,
      entry: buildToolLogEntry(toolName, it.part, resolved),
      // The fallback for a verbless tool is the FULL resolved label ("Linear ·
      // create_issue"), not the row's bare object, which drops the server.
      label: resolved.label,
      duration: formatToolDuration(getToolDurationMs(it.part)),
    };
  });
  const single = items.length === 1;
  const active = items.some((it) => isActiveToolState(it.part.state));
  const errorCount = items.filter((it) => isError(it.part.state)).length;

  // Verb-led summary: a single tool's own phrase ("Edited next.config.ts +12 −3"),
  // or a run collapsed by verb ("Ran 3 commands, read 2 files, edited a file").
  const first = items[0];
  const line: ToolLine =
    single && first
      ? getSingleToolLine(getToolName(first.part), first.part, rows[0]?.label ?? "")
      : getRunToolLine(items.map((it) => ({ toolName: getToolName(it.part), part: it.part })));
  const state: ActivityState = active ? "active" : errorCount > 0 ? "error" : "idle";
  const ariaLabel = line.segments.map((seg) => seg.text).join(" ");

  const strip = <ActivityLine segments={line.segments} state={state} label={ariaLabel} />;

  // The header continues the line that was tapped rather than restating a count,
  // so opening the run never reads as starting over.
  const deniedCount = rows.filter((r) => r.entry.state === "denied").length;
  const totalMs = items.reduce((sum, it) => sum + (getToolDurationMs(it.part) ?? 0), 0);
  const totalDuration = formatToolDuration(totalMs);

  const header = (
    <>
      <span className="font-display text-base leading-snug">{ariaLabel}</span>
      <span className="mt-1.5 flex flex-wrap items-center gap-2">
        {errorCount > 0 ? (
          <span className="inline-flex rounded-full border border-reject/40 bg-reject/10 px-2 py-px text-[11px] font-semibold text-reject">
            {errorCount} failed
          </span>
        ) : null}
        {deniedCount > 0 ? (
          <span className="inline-flex rounded-full border border-steer/40 bg-steer-bg px-2 py-px text-[11px] font-semibold text-steer">
            {deniedCount} denied
          </span>
        ) : null}
        {totalDuration ? (
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {totalDuration}
          </span>
        ) : null}
        <span className="text-xs text-muted-foreground">
          {items.length} call{single ? "" : "s"}
        </span>
      </span>
    </>
  );

  // The log lives inside a height-capped flex column (header pinned), so a long
  // run scrolls within the modal instead of overflowing the viewport.
  const body = <ToolRunLog entries={rows} />;

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>{strip}</SheetTrigger>
        <SheetContent
          side="bottom"
          className="flex max-h-[85vh] flex-col gap-0 p-0 pb-[env(safe-area-inset-bottom)]"
        >
          <SheetHeader className="shrink-0 border-b py-4 pl-5 pr-12">
            <SheetTitle className="flex flex-col items-start">{header}</SheetTitle>
          </SheetHeader>
          {body}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{strip}</DialogTrigger>
      <DialogContent className="flex max-h-[82vh] flex-col gap-0 p-0 sm:max-w-3xl">
        <DialogHeader className="shrink-0 border-b py-4 pl-5 pr-12">
          <DialogTitle className="flex flex-col items-start">{header}</DialogTitle>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}
