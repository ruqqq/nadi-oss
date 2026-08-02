// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
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

describe("ChatLog typing indicator spacing", () => {
  // ConversationContent uses gap-8 between children. Without a pull-up the
  // dots sit a full message-gap below the previous bubble, which reads as a
  // hole rather than "still working on that reply".
  it("pulls the typing dots up toward the previous message", () => {
    const messages: UIMessage[] = [
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "Hello" }],
      },
    ];
    const { getByRole } = render(
      <ChatLog
        messages={messages}
        addToolApprovalResponse={() => {}}
        busy
        showTyping
        servers={[]}
      />,
    );
    const dots = getByRole("status", { name: "Nadi is responding" });
    expect(dots.parentElement?.className).toMatch(/-mt-/);
  });
});
