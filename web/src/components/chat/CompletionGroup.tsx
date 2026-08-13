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
import { completionLineModel, type CompletionLineModel } from "@/lib/completion-line";
import type { SubagentRunView } from "@/lib/subagent-runs";
import type { LineSegment } from "@/lib/tool-summary";
import { ActivityLine } from "./ActivityLine";
import { CompletionResult } from "./CompletionResult";

/**
 * A consecutive run of watcher/subagent completions (see lib/completion-group.ts),
 * rendered the same way tool calls are: as recessed `ActivityLine`s that open an
 * inspector (bottom Sheet on mobile, centered Dialog on desktop).
 *
 * EVERY completion is a line — that is the redesign. This used to render a
 * tinted, shadowed card per completion and only reach for `ActivityLine` once a
 * run hit three, so the loudest treatment in the transcript landed on the
 * quietest event: a single background task finishing cleanly. The line was
 * already here and already shared with `ToolGroup`; the threshold now only
 * decides whether N lines COLLAPSE into one summary line, not whether a
 * completion looks like an announcement or like an activity.
 *
 * Success is silent by `ActivityLine`'s contract — no glyph, no tint, text flush
 * with the prose — and a failure gets its hanging warning marker for free.
 */
const GROUP_MIN = 3;

/** A completion paired with its message id, so a filtered list keeps its keys. */
interface CompletionEntry {
  id: string;
  model: CompletionLineModel;
}

/** One completion: a line, and the result panel it opens. */
function CompletionLine({
  message,
  runsById,
}: {
  message: UIMessage;
  runsById: Record<string, SubagentRunView>;
}) {
  const [open, setOpen] = useState(false);
  const isMobile = useMediaQuery("(max-width: 640px)");
  const model = completionLineModel(message, runsById);
  // Not a completion after all (the grouping predicate and the model parse
  // agree in practice; this keeps a mismatch from rendering an empty trigger).
  if (!model) return null;

  const strip = <ActivityLine segments={model.segments} state={model.state} label={model.label} />;
  const body = (
    <div className="min-h-0 flex-auto overflow-y-auto p-4">
      {/* The Sheet/Dialog header already names the task, so the panel does not
          repeat it — it leads with the status chip and the result. */}
      <CompletionResult model={model} headed={false} />
    </div>
  );
  const heading = (
    <span className={model.kind === "process" ? "font-mono text-sm" : "font-display text-base"}>
      {model.title}
    </span>
  );

  return (
    <Inspector
      open={open}
      setOpen={setOpen}
      isMobile={isMobile}
      trigger={strip}
      heading={heading}
      body={body}
    />
  );
}

/** The collapsed summary for a run of GROUP_MIN or more. */
function CompletionRun({ entries }: { entries: CompletionEntry[] }) {
  const [open, setOpen] = useState(false);
  const isMobile = useMediaQuery("(max-width: 640px)");

  const errorCount = entries.filter((e) => e.model.tone === "bad").length;
  const names = entries.map((e) => e.model.title).join(", ");
  // Counts what is actually LISTED, not what arrived: a message the model could
  // not parse contributes no panel, so counting it here would promise a result
  // the inspector does not contain.
  const title = `${entries.length} background results`;

  const segments: LineSegment[] = [{ text: title }];
  if (names) segments.push({ text: `· ${names}`, tone: "faint" });
  const strip = (
    <ActivityLine
      segments={segments}
      state={errorCount > 0 ? "error" : "idle"}
      label={`${title}${names ? ` — ${names}` : ""}`}
    />
  );

  const body = (
    <div className="min-h-0 flex-auto divide-y overflow-y-auto">
      {entries.map(({ id, model }) => (
        <div key={id} className="p-4">
          <CompletionResult model={model} />
        </div>
      ))}
    </div>
  );

  return (
    <Inspector
      open={open}
      setOpen={setOpen}
      isMobile={isMobile}
      trigger={strip}
      heading={<span className="font-display text-base">{title}</span>}
      body={body}
    />
  );
}

/** The Sheet/Dialog split, identical to `ToolGroup`'s, in one place. */
function Inspector({
  open,
  setOpen,
  isMobile,
  trigger,
  heading,
  body,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  isMobile: boolean;
  trigger: React.ReactNode;
  heading: React.ReactNode;
  body: React.ReactNode;
}) {
  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>{trigger}</SheetTrigger>
        <SheetContent
          side="bottom"
          className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 pb-[env(safe-area-inset-bottom)]"
        >
          <SheetHeader className="shrink-0 border-b px-5 py-4">
            <SheetTitle className="flex flex-col items-start text-left">{heading}</SheetTitle>
          </SheetHeader>
          {body}
        </SheetContent>
      </Sheet>
    );
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="flex max-h-[82vh] flex-col gap-0 p-0 sm:max-w-xl">
        <DialogHeader className="shrink-0 border-b px-5 py-4">
          <DialogTitle className="flex flex-col items-start text-left">{heading}</DialogTitle>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}

export function CompletionGroup({
  run,
  runsById,
}: {
  run: UIMessage[];
  runsById: Record<string, SubagentRunView>;
}) {
  if (run.length < GROUP_MIN) {
    return (
      <>
        {run.map((message) => (
          <CompletionLine key={message.id} message={message} runsById={runsById} />
        ))}
      </>
    );
  }

  // Message and model stay PAIRED through the filter. Mapping then filtering
  // separately would leave the surviving models indexed against the original
  // message list, so every key after a dropped message would name the wrong
  // message.
  const entries: CompletionEntry[] = run.flatMap((message) => {
    const model = completionLineModel(message, runsById);
    return model ? [{ id: message.id, model }] : [];
  });
  if (entries.length === 0) return null;

  return <CompletionRun entries={entries} />;
}
