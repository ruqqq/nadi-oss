// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { UIMessage } from "ai";
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

const THINKING_TEXT = "Weighing the two approaches";

const messages: UIMessage[] = [
  {
    id: "m1",
    role: "assistant",
    parts: [
      { type: "reasoning", text: THINKING_TEXT, state: "streaming" },
      { type: "text", text: "Here is the answer." },
    ],
  } as unknown as UIMessage,
];

function renderLog(showReasoning: boolean | undefined) {
  render(
    <ChatLog
      messages={messages}
      addToolApprovalResponse={() => undefined}
      busy={true}
      showTyping={false}
      servers={[]}
      {...(showReasoning === undefined ? {} : { showReasoning })}
    />,
  );
}

describe("ChatLog reasoning visibility", () => {
  it("hides the live thinking block when reasoning display is off", () => {
    // This is the ONLY place thinking is rendered — MessageRow is always passed
    // showReasoning={false}. The flag is the per-user display preference:
    // callers pass what `GET /api/settings/preferences` returned.
    renderLog(false);
    expect(screen.queryByText(THINKING_TEXT)).not.toBeInTheDocument();
    // The answer itself must still render — this hides thinking, not the turn.
    expect(screen.getByText("Here is the answer.")).toBeInTheDocument();
  });

  it("shows the live thinking block when reasoning display is on", () => {
    renderLog(true);
    expect(screen.getByText(THINKING_TEXT)).toBeInTheDocument();
  });

  it("defaults to showing, so callers that never opted in are unchanged", () => {
    renderLog(undefined);
    expect(screen.getByText(THINKING_TEXT)).toBeInTheDocument();
  });
});
