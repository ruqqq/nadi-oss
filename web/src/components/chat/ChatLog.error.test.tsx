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

const LONG_URL =
  "https://opencode.ai/workspace/wrk_01KX2X3PFE4YJHPJWABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ERROR_MESSAGE = `Failed after 3 attempts. Last error: Weekly usage limit reached. To continue using this model now, enable usage from balance: ${LONG_URL}`;

describe("ChatLog error overflow", () => {
  it("wraps long unbreakable tokens in the turn-error alert", () => {
    // Provider errors often embed a URL with no spaces. Without overflow-wrap
    // and a shrinkable grid column, that token stretches the alert past the
    // conversation edge — the same overflow the compaction digest already
    // guards with min-w-0 + overflow-wrap:anywhere.
    render(
      <ChatLog
        messages={
          [
            {
              id: "m1",
              role: "user",
              parts: [{ type: "text", text: "What do you see?" }],
            },
          ] as UIMessage[]
        }
        addToolApprovalResponse={() => undefined}
        busy={false}
        showTyping={false}
        servers={[]}
        error={new Error(ERROR_MESSAGE)}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(ERROR_MESSAGE);
    expect(alert).toHaveClass("min-w-0");

    const description = alert.querySelector("[data-slot=alert-description]");
    expect(description).not.toBeNull();
    expect(description).toHaveClass("min-w-0", "[overflow-wrap:anywhere]");
  });
});
