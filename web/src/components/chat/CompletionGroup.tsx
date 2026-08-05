import { useState } from "react";
import type { UIMessage } from "ai";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useMediaQuery } from "@/lib/use-media-query";
import {
  isWatcherCompletionMessage,
  parseWatcherCompletion,
  watcherResultModel,
} from "@/lib/watcher-runs";
import { subagentResultModel, type SubagentRunView } from "@/lib/subagent-runs";
import type { LineSegment } from "@/lib/tool-summary";
import { ActivityLine } from "./ActivityLine";
import { WatcherResultNotice } from "./WatcherResultNotice";
import { SubagentResultNotice } from "./SubagentResultNotice";

// A consecutive run of watcher/subagent completions (see lib/completion-group.ts).
// A short run renders as individual cards; a longer run collapses into ONE
// "Dispatch strip" — the same UX as grouped tool calls (ToolGroup): a strip
// showing "N background results" + a done/error tally that opens an inspector
// (bottom Sheet on mobile, centered Dialog on desktop) listing the individual
// result cards. Keeps a busy coding turn from dumping 20 cards into the transcript.
const GROUP_MIN = 3;

function completionInfo(
  message: UIMessage,
  runsById: Record<string, SubagentRunView>,
): { title: string; ok: boolean } {
  if (isWatcherCompletionMessage(message)) {
    const info = parseWatcherCompletion(message);
    const model = info ? watcherResultModel(info) : null;
    return { title: model?.title ?? "Watcher", ok: model?.tone === "success" };
  }
  const model = subagentResultModel(message, runsById);
  return { title: model.title, ok: model.tone === "success" };
}

function renderCard(message: UIMessage, runsById: Record<string, SubagentRunView>) {
  return isWatcherCompletionMessage(message) ? (
    <WatcherResultNotice key={message.id} message={message} />
  ) : (
    <SubagentResultNotice key={message.id} message={message} runsById={runsById} />
  );
}

export function CompletionGroup({
  run,
  runsById,
}: {
  run: UIMessage[];
  runsById: Record<string, SubagentRunView>;
}) {
  const [open, setOpen] = useState(false);
  const isMobile = useMediaQuery("(max-width: 640px)");

  if (run.length < GROUP_MIN) {
    return <>{run.map((message) => renderCard(message, runsById))}</>;
  }

  const infos = run.map((message) => completionInfo(message, runsById));
  const errorCount = infos.filter((i) => !i.ok).length;
  const names = infos.map((i) => i.title).join(", ");
  const title = `${run.length} background results`;

  // The same recessed activity line as ToolGroup: verb-led-style summary, silent
  // on success, a hanging warning only when a background run failed.
  const segments: LineSegment[] = [{ text: title }];
  if (names) segments.push({ text: `· ${names}`, tone: "faint" });
  const strip = (
    <ActivityLine
      segments={segments}
      state={errorCount > 0 ? "error" : "idle"}
      label={`${title}${names ? ` — ${names}` : ""}`}
    />
  );

  // Scrollable list inside a height-capped flex column (header pinned), matching ToolGroup.
  const body = (
    <div className="min-h-0 flex-auto overflow-y-auto p-4">
      {run.map((message) => renderCard(message, runsById))}
    </div>
  );

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>{strip}</SheetTrigger>
        <SheetContent side="bottom" className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0">
          <SheetHeader className="shrink-0 border-b px-5 py-4">
            <SheetTitle className="font-display text-base">{title}</SheetTitle>
          </SheetHeader>
          {body}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{strip}</DialogTrigger>
      <DialogContent className="flex max-h-[82vh] flex-col gap-0 p-0 sm:max-w-xl">
        <DialogHeader className="shrink-0 border-b px-5 py-4">
          <DialogTitle className="font-display text-base">{title}</DialogTitle>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}
