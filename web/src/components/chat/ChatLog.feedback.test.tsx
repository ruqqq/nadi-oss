// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { FileUIPart, UIMessage } from "ai";
import { ChatLog } from "./ChatLog";

beforeAll(() => {
  class TestResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = TestResizeObserver as typeof ResizeObserver;
});

afterEach(() => cleanup());

describe("ChatLog feedback drafts", () => {
  it("shows uploaded user screenshots referenced by an interviewer draft", () => {
    const uploadedScreenshot = {
      type: "file",
      mediaType: "image/png",
      filename: "flicker.png",
      url: "data:image/png;base64,AAAA",
      attachmentId: "att_1",
    } as FileUIPart & { attachmentId: string };

    render(
      <ChatLog
        messages={[
          {
            id: "msg_user",
            role: "user",
            parts: [{ type: "text", text: "The archive button flickers." }, uploadedScreenshot],
          } as UIMessage,
          feedbackDraftMessage(["att_1"]),
        ]}
        addToolApprovalResponse={vi.fn()}
        busy={false}
        showTyping={false}
        servers={[]}
        onFeedbackDraftEdit={vi.fn()}
        onFeedbackDraftSubmit={vi.fn()}
      />,
    );

    const card = screen.getByRole("button", { name: "Submit feedback" }).closest('[data-slot="card"]');
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getByRole("button", { name: "View flicker.png" })).toBeTruthy();
  });

  it("keeps a submitted interviewer draft in the sent state after remount", () => {
    render(
      <ChatLog
        messages={[feedbackDraftMessage([])]}
        addToolApprovalResponse={vi.fn()}
        busy={false}
        showTyping={false}
        servers={[]}
        submittedFeedbackDraftIds={new Set(["draft_1"])}
        onFeedbackDraftEdit={vi.fn()}
        onFeedbackDraftSubmit={vi.fn()}
      />,
    );

    expect(screen.getByText("Sent to the Nadi team")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Submit feedback" })).toBeNull();
  });
});

describe("ChatLog empty state", () => {
  it("shows the empty prompt when a thread has no messages", () => {
    render(
      <ChatLog
        messages={[]}
        addToolApprovalResponse={vi.fn()}
        busy={false}
        showTyping={false}
        servers={[]}
      />,
    );

    expect(screen.getByText("No messages yet")).toBeTruthy();
  });

  it("suppresses the empty prompt while a first-message bubble renders below the log", () => {
    // A freshly-created thread has no persisted messages yet, but its optimistic
    // bubble is on screen — the "No messages yet" copy must not flash over it.
    render(
      <ChatLog
        messages={[]}
        addToolApprovalResponse={vi.fn()}
        busy={false}
        showTyping={false}
        servers={[]}
        hasPendingBubble
      />,
    );

    expect(screen.queryByText("No messages yet")).toBeNull();
  });
});

function feedbackDraftMessage(attachmentIds: string[]): UIMessage {
  return {
    id: "msg_assistant",
    role: "assistant",
    parts: [
      { type: "text", text: "Please review this draft." },
      { type: "step-start" },
      {
        type: "tool-prepare_feedback_report",
        toolCallId: "call_feedback",
        state: "output-available",
        input: {},
        output: {
          draft: {
            id: "draft_1",
            interviewId: "interview_1",
            fields: {
              category: "bug",
              title: "Archive button flickers",
              narrative: "The archive button flickers when I open the row menu.",
              reproductionSteps: ["Open a chat row", "Click archive"],
              expectedBehavior: "The archive action stays stable.",
              actualBehavior: "The archive action flickers.",
              frequency: "Every time",
              impact: "Archiving feels risky.",
            },
            attachmentIds,
            createdAt: 1_700_000_000_000,
          },
        },
      },
    ],
  } as unknown as UIMessage;
}
