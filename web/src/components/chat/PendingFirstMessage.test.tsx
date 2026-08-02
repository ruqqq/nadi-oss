// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { FileUIPart } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PendingFirstMessage } from "./PendingFirstMessage";

const image: FileUIPart = {
  type: "file",
  url: "https://r2.example/att_1",
  mediaType: "image/png",
  filename: "shot.png",
};

afterEach(() => {
  cleanup();
});

describe("PendingFirstMessage", () => {
  it("shows the message as sending, with no retry offered yet", () => {
    render(<PendingFirstMessage text="Summarise this" files={[]} status="sending" />);

    expect(screen.getByText("Summarise this")).toBeInTheDocument();
    expect(screen.getByText("Sending…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
  });

  it("marks a failed delivery and offers a retry", () => {
    render(
      <PendingFirstMessage text="Summarise this" files={[]} status="failed" onRetry={() => {}} />,
    );

    expect(screen.getByText("Not sent")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    expect(screen.queryByText("Sending…")).not.toBeInTheDocument();
  });

  it("retries the message when the user asks", async () => {
    const onRetry = vi.fn();
    render(
      <PendingFirstMessage text="Summarise this" files={[]} status="failed" onRetry={onRetry} />,
    );

    await userEvent.click(screen.getByRole("button", { name: /retry/i }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  // The attachment IS the message here (the composer allows an empty text when
  // files are staged), so the bubble must still say something rather than render
  // an empty box the user can't identify.
  it("still reads as a message when the attachment is the whole message", () => {
    render(<PendingFirstMessage text="" files={[image]} status="failed" onRetry={() => {}} />);

    expect(screen.getByText("Attachment")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});
