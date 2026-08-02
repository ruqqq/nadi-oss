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

const user: UIMessage = { id: "u1", role: "user", parts: [{ type: "text", text: "Hello" }] };

function renderLog(messages: UIMessage[]) {
  const { getByRole } = render(
    <ChatLog
      messages={messages}
      addToolApprovalResponse={() => {}}
      busy
      showTyping
      servers={[]}
    />,
  );
  return getByRole("status", { name: "Nadi is responding" }).parentElement?.className ?? "";
}

describe("ChatLog typing indicator spacing", () => {
  // Before the turn paints, the dots ARE the assistant message: nothing else
  // stands in for it. They keep ConversationContent's gap-8 so the first token
  // lands on the line they were holding. Pulling them up under the user bubble
  // instead parked them 32px above that line, and they fell the moment text
  // arrived — the extra gap that appeared as soon as streaming started.
  it("leaves the dots in the message slot before the turn paints", () => {
    expect(renderLog([user])).not.toMatch(/-mt-/);
  });

  // An empty log has nothing to pull up toward either — a negative margin here
  // would drag the dots into the container's own top padding.
  it("leaves the dots in the message slot with no messages at all", () => {
    expect(renderLog([])).not.toMatch(/-mt-/);
  });

  // Once the turn HAS painted the dots trail it, so they cancel the message gap
  // and re-add the 12px trailing rhythm prose and tool rows settle at.
  it("pulls the dots up under an assistant message that has painted", () => {
    const assistant: UIMessage = {
      id: "a1",
      role: "assistant",
      parts: [{ type: "text", text: "Working on it" }],
    };
    expect(renderLog([user, assistant])).toMatch(/-mt-/);
  });

  // A contentless assistant row is filtered out before this decision, so it
  // must not count as "painted" — that is the row the SDK inserts the instant a
  // stream opens, and treating it as painted reinstates the 32px drop.
  it("does not treat an empty assistant placeholder as painted", () => {
    const placeholder: UIMessage = { id: "a1", role: "assistant", parts: [] };
    expect(renderLog([user, placeholder])).not.toMatch(/-mt-/);
  });
});
