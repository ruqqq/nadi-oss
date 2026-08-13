import { MessageResponse } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";
import type { CompletionLineModel, CompletionTone } from "@/lib/completion-line";

/**
 * What a completion's `ActivityLine` opens: the task's name, its outcome, and
 * the result body.
 *
 * The one place a completion's result is rendered — the transcript inspector
 * (one panel, or a list of them for a grouped run) and the background-tasks
 * sheet both use this, so the sheet cannot drift into describing a finished run
 * differently from the transcript.
 *
 * The tone appears exactly ONCE, in the status chip. That is the whole point of
 * the redesign: the card this replaces stated the outcome three times over — a
 * tinted border, a filled coloured glyph, and the status text — which is what
 * made a routine success the loudest thing in the transcript.
 */

const CHIP_TONE: Record<CompletionTone, string> = {
  ok: "border-approve/40 bg-approve/10 text-approve",
  bad: "border-reject/40 bg-reject/10 text-reject",
  pending: "border-border bg-muted text-muted-foreground",
};

export function CompletionResult({
  model,
  /** Renders the name as a heading. Off inside a grouped list, where each entry
   *  needs its own heading, but on for a single panel whose Sheet/Dialog header
   *  already carries the name. */
  headed = true,
}: {
  model: CompletionLineModel;
  headed?: boolean;
}) {
  return (
    <div className="not-prose flex flex-col gap-2">
      {headed ? (
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "min-w-0 flex-1 break-words font-display text-base leading-snug",
              // A command is a command; rendering it in the display face makes
              // it read as a title rather than as something you could retype.
              model.kind === "process" && "font-mono text-sm",
            )}
          >
            {model.title}
          </span>
          <StatusChip model={model} />
        </div>
      ) : (
        <StatusChip model={model} />
      )}
      <CompletionResultBody model={model} />
    </div>
  );
}

/**
 * The result body alone, no heading and no status.
 *
 * Separate because the background-tasks sheet needs exactly this: its row
 * already shows the task's name, its duration and its outcome, so a panel that
 * repeated the chip would state the outcome twice in one row — the habit this
 * whole change exists to break.
 */
export function CompletionResultBody({ model }: { model: CompletionLineModel }) {
  if (model.kind === "process") {
    // A process body is an output tail: pre-formatted, never markdown. Piping it
    // through the markdown renderer would eat its indentation and treat stray
    // `#`/`*` in log output as formatting.
    return (
      <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md border bg-card px-2.5 py-2 font-mono text-[11.5px] leading-relaxed">
        {model.body}
      </pre>
    );
  }
  return <MessageResponse>{model.body}</MessageResponse>;
}

function StatusChip({ model }: { model: CompletionLineModel }) {
  return (
    <span
      data-testid="completion-status"
      data-tone={model.tone}
      className={cn(
        "inline-flex w-fit shrink-0 whitespace-nowrap rounded-full border px-2 py-px text-[11px] font-semibold",
        CHIP_TONE[model.tone],
      )}
    >
      {model.statusLabel}
    </span>
  );
}
