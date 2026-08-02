import { useState } from "react";
import type { UIMessage } from "ai";
import { MessageResponse } from "@/components/ai-elements/message";
import { subagentResultModel, type SubagentRunView, type SubagentTone } from "@/lib/subagent-runs";
import { CaretDown, CaretRight, CheckCircle, Cpu, XCircle } from "@/icons";

const toneRing: Record<SubagentTone, string> = {
  running: "border-blue-500/40",
  success: "border-green-500/40",
  error: "border-red-500/40",
  stopped: "border-orange-500/40",
};

// Icon colour mirrors the border tint so a glance at the icon alone (not just
// the container border) tells completed (green) apart from error (red) apart
// from a stopped run — aborted or interrupted (orange), including an
// interrupted-with-reason case, whose distinct text now comes from
// `subagentResultModel` (`statusLabelFor`).
const toneIconColor: Record<SubagentTone, string> = {
  running: "text-blue-600",
  success: "text-green-600",
  error: "text-red-600",
  stopped: "text-orange-600",
};

export function SubagentResultNotice({
  message,
  runsById,
}: {
  message: UIMessage;
  runsById: Record<string, SubagentRunView>;
}) {
  const [expanded, setExpanded] = useState(false);
  const model = subagentResultModel(message, runsById);
  const Icon = model.tone === "success" ? CheckCircle : model.tone === "running" ? Cpu : XCircle;
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
          Subagent · {model.statusLabel}
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
