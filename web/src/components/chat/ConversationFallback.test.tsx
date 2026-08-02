// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationFallback } from "./ConversationFallback";

describe("ConversationFallback", () => {
  afterEach(cleanup);

  it("shows the loading skeleton for an ordinary thread open", () => {
    render(<ConversationFallback hasPendingBubble={false} />);
    expect(screen.getByRole("status", { name: "Loading conversation" })).toBeTruthy();
  });

  it("shows no placeholder bars over an optimistic bubble", () => {
    render(<ConversationFallback hasPendingBubble />);
    expect(screen.queryByRole("status", { name: "Loading conversation" })).toBeNull();
  });

  // THE REGRESSION GUARD. This used to be `null`, and "no placeholder bars"
  // silently became "no element at all". The bubble and typing dots sit BELOW
  // this slot in a flex column, so a zero-height fallback let them ride to the
  // top of the pane and snap ~600px down when ChatLog resolved. The fallback
  // has to keep occupying the space.
  it("still occupies the conversation area so the bubble does not move", () => {
    render(<ConversationFallback hasPendingBubble />);
    const spacer = screen.getByTestId("conversation-spacer");
    expect(spacer.className).toContain("flex-1");
  });
});
