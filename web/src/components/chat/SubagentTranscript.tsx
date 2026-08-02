import { isToolUIPart, type ToolUIPart, type UIMessage } from "ai";
import { MessageResponse } from "@/components/ai-elements/message";
import type { ToolNameServer } from "@/lib/resolve-tool-name";
import { ToolGroup } from "./ToolGroup";

/**
 * The subagent child's streamed message parts (text + tool calls), rendered for
 * the drill-in. Live parts only — empty once a run has aged out of event state
 * (e.g. after reload), which shows a placeholder rather than a blank panel.
 */
export function SubagentTranscript({
  parts,
  servers,
  isRunning,
}: {
  parts?: UIMessage["parts"];
  servers: ToolNameServer[];
  isRunning: boolean;
}) {
  if (!parts || parts.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        {isRunning ? "Waiting for the subagent to stream output…" : "Transcript unavailable."}
      </p>
    );
  }
  return (
    <>
      {parts.map((part, i) =>
        part.type === "text" ? (
          <MessageResponse key={i}>{part.text}</MessageResponse>
        ) : isToolUIPart(part) ? (
          <ToolGroup
            key={i}
            items={[{ key: String(i), part: part as ToolUIPart }]}
            servers={servers}
          />
        ) : null,
      )}
    </>
  );
}
