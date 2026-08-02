import { useState } from "react";
import type { UIMessage } from "ai";
import { MessageResponse } from "@/components/ai-elements/message";
import {
  parseWatcherCompletion,
  watcherResultModel,
  type WatcherResultTone,
} from "@/lib/watcher-runs";
import { CaretDown, CaretRight, CheckCircle, Clock, WarningCircle, XCircle } from "@/icons";

// Mirrors SubagentResultNotice: a bordered/tinted card rendered inline in the
// transcript when a watched background process completes. Tone maps the ledger
// terminal to colour — clean exit (green), non-zero exit (red), watch timeout /
// deliberate stop (orange), reaper fault (the `--reject` intent) — so the icon
// alone tells them apart at a glance. A fault is a FAILURE, not a neutral
// "we stopped watching", hence reject rather than the timeout's tone.
const toneRing: Record<WatcherResultTone, string> = {
  success: "border-green-500/40",
  error: "border-red-500/40",
  stopped: "border-orange-500/40",
  fault: "border-reject/50",
};

const toneIconColor: Record<WatcherResultTone, string> = {
  success: "text-green-600",
  error: "text-red-600",
  stopped: "text-orange-600",
  fault: "text-reject",
};

const toneIcon: Record<WatcherResultTone, typeof CheckCircle> = {
  success: CheckCircle,
  error: XCircle,
  stopped: Clock,
  fault: WarningCircle,
};

export function WatcherResultNotice({ message }: { message: UIMessage }) {
  const [expanded, setExpanded] = useState(false);
  const info = parseWatcherCompletion(message);
  if (!info) return null;
  const model = watcherResultModel(info);
  const Icon = toneIcon[model.tone];
  const Caret = expanded ? CaretDown : CaretRight;

  return (
    <div
      className={`not-prose mb-4 rounded-md border bg-card/60 p-3 shadow-sm ${toneRing[model.tone]}`}
    >
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 text-left"
      >
        <Icon className={`size-4 flex-none ${toneIconColor[model.tone]}`} weight="fill" />
        <span className="min-w-0 flex-1 truncate font-medium text-sm">{model.title}</span>
        <span className="flex-none text-muted-foreground text-xs">
          Watcher · {model.statusLabel}
        </span>
        <Caret className="size-3 flex-none text-muted-foreground" />
      </button>
      {expanded && (
        <div className="mt-2">
          <MessageResponse>{model.body}</MessageResponse>
        </div>
      )}
    </div>
  );
}
