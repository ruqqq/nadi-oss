import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { useState } from "react";
import { getToolApproval, getToolInput } from "@cloudflare/ai-chat/react";
import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
} from "@/components/ai-elements/confirmation";
import { CodeBlock } from "@/components/ai-elements/code-block";
import { resolveToolName, type ToolNameServer } from "@/lib/resolve-tool-name";
import { Check, X } from "@/icons";

type Part = UIMessage["parts"][number];

/**
 * Nadi's signature: the human-in-the-loop approval gate. Wraps AI Elements'
 * Confirmation (which already speaks addToolApprovalResponse) and themes it with
 * the aubergine --gate tokens. We pass the raw AI SDK v5/v6 part.state through —
 * Confirmation gates its own request/accepted/rejected sections on it.
 */
export function ApprovalGate({
  part,
  servers,
  disabled,
  onApprove,
  onReject,
}: {
  part: Part;
  /** Workspace MCP servers, for mapping the namespaced tool key to a friendly name. */
  servers: ToolNameServer[];
  disabled: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const [responding, setResponding] = useState(false);

  if (!isToolUIPart(part)) return null;
  const approval = getToolApproval(part);
  if (!approval) return null;

  const gateDisabled = disabled || responding;

  const name = resolveToolName(getToolName(part), servers).label;
  const input = getToolInput(part);

  const handleApprove = () => {
    if (gateDisabled) return;
    setResponding(true);
    onApprove();
  };

  const handleReject = () => {
    if (gateDisabled) return;
    setResponding(true);
    onReject();
  };

  return (
    <Confirmation approval={approval} state={part.state} className="border-gate/50 bg-gate-bg">
      <ConfirmationRequest>
        <div className="flex flex-col gap-0.5">
          <ConfirmationTitle className="font-medium text-gate">Approval required</ConfirmationTitle>
          <span className="text-muted-foreground text-xs">
            Nadi wants to run <span className="font-mono text-foreground">{name}</span>.
          </span>
        </div>

        {input !== undefined && (
          // w-full + min-w-0: the Confirmation card is a column flex container
          // with `items-start`, so without an explicit width this wrapper sizes
          // to the JSON's max-content width and overflows the card — leaving
          // CodeBlock's inner `overflow-auto` pane as wide as its own content,
          // i.e. nothing to scroll, and long args simply clipped. Pinning it to
          // the card width lets that pane scroll horizontally instead.
          <div className="mt-2 w-full min-w-0 overflow-hidden rounded-md bg-muted/50">
            <CodeBlock code={JSON.stringify(input, null, 2)} language="json" />
          </div>
        )}

        <ConfirmationActions className="mt-3">
          <ConfirmationAction
            variant="outline"
            disabled={gateDisabled}
            onClick={handleReject}
            className="gap-1.5 border-reject/50 text-reject hover:bg-reject/10 hover:text-reject"
          >
            <X />
            Reject
          </ConfirmationAction>
          <ConfirmationAction
            disabled={gateDisabled}
            onClick={handleApprove}
            className="gap-1.5 bg-approve text-approve-foreground hover:bg-approve/90"
          >
            <Check />
            Approve
          </ConfirmationAction>
        </ConfirmationActions>
      </ConfirmationRequest>

      <ConfirmationAccepted>
        <ConfirmationTitle className="text-approve">
          Approved — running <span className="font-mono">{name}</span>.
        </ConfirmationTitle>
      </ConfirmationAccepted>

      <ConfirmationRejected>
        <ConfirmationTitle className="text-reject">
          Rejected <span className="font-mono">{name}</span>.
        </ConfirmationTitle>
      </ConfirmationRejected>
    </Confirmation>
  );
}
