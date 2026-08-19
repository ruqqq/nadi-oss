// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { UIMessage } from "ai";
import { MessageRow } from "./MessageRow";
import { MODEL_SWITCH_PART_TYPE } from "@/lib/model-switch";

afterEach(() => cleanup());

/**
 * The component test (`ModelSwitchDivider.test.tsx`) only proves the divider
 * itself renders correctly given props — it says nothing about whether
 * MessageRow actually reaches for it. A part that a renderer never wires in
 * is the classic failure this guards against.
 */
describe("MessageRow model-switch divider", () => {
  it("renders a divider above a user message carrying a model-switch part", () => {
    const modelSwitchPart = {
      type: MODEL_SWITCH_PART_TYPE,
      data: {
        from: { provider: "openai", model: "gpt-5" },
        to: { provider: "anthropic", model: "claude-opus-5" },
      },
    } as UIMessage["parts"][number];
    const message: UIMessage = {
      id: "msg_user",
      role: "user",
      parts: [modelSwitchPart, { type: "text", text: "hello" }],
    };

    render(
      <MessageRow message={message} addToolApprovalResponse={vi.fn()} busy={false} servers={[]} />,
    );

    expect(screen.getByRole("separator")).toBeInTheDocument();
    expect(screen.getByText(/claude-opus-5/)).toBeInTheDocument();
    expect(screen.getByText("hello")).toBeInTheDocument();
  });

  it("renders no divider for a plain user message", () => {
    const message: UIMessage = {
      id: "msg_user",
      role: "user",
      parts: [{ type: "text", text: "hello" }],
    };

    render(
      <MessageRow message={message} addToolApprovalResponse={vi.fn()} busy={false} servers={[]} />,
    );

    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
  });
});
