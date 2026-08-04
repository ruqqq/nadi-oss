// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ToolUIPart, UIMessage } from "ai";
import { MessageRow } from "./MessageRow";

afterEach(() => cleanup());

function approvalToolPart(
  toolName: string,
  approvalId: string,
): ToolUIPart & { approval: { id: string } } {
  return {
    type: `tool-${toolName}`,
    toolCallId: `call_${approvalId}`,
    state: "approval-requested",
    approval: { id: approvalId },
    input: { action: toolName },
  } as ToolUIPart & { approval: { id: string } };
}

function messageWithApprovals(...parts: ToolUIPart[]): UIMessage {
  return {
    id: "msg_assistant",
    role: "assistant",
    parts,
  } as UIMessage;
}

describe("MessageRow approval gates", () => {
  it("keeps sibling approval buttons enabled while the chat is busy", () => {
    const addToolApprovalResponse = vi.fn();

    render(
      <MessageRow
        message={messageWithApprovals(
          approvalToolPart("delete_release", "appr_1"),
          approvalToolPart("send_email", "appr_2"),
        )}
        addToolApprovalResponse={addToolApprovalResponse}
        busy
        servers={[]}
      />,
    );

    const approveButtons = screen.getAllByRole("button", { name: "Approve" });
    const rejectButtons = screen.getAllByRole("button", { name: "Reject" });

    expect(approveButtons).toHaveLength(2);
    expect(rejectButtons).toHaveLength(2);
    for (const button of [...approveButtons, ...rejectButtons]) {
      expect((button as HTMLButtonElement).disabled).toBe(false);
    }
  });

  it("routes each approval decision to its own approval id", () => {
    const addToolApprovalResponse = vi.fn();

    render(
      <MessageRow
        message={messageWithApprovals(
          approvalToolPart("delete_release", "appr_1"),
          approvalToolPart("send_email", "appr_2"),
        )}
        addToolApprovalResponse={addToolApprovalResponse}
        busy={false}
        servers={[]}
      />,
    );

    screen.getAllByRole("button", { name: "Approve" })[1]?.click();
    expect(addToolApprovalResponse).toHaveBeenCalledWith({ id: "appr_2", approved: true });

    screen.getAllByRole("button", { name: "Reject" })[0]?.click();
    expect(addToolApprovalResponse).toHaveBeenCalledWith({ id: "appr_1", approved: false });
  });
});
