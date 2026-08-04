// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { FileUIPart } from "ai";
import { afterEach, describe, expect, it } from "vitest";

import { MessageAttachmentView } from "./MessageAttachmentView";

const image: FileUIPart = {
  type: "file",
  url: "/api/attachments/att_1",
  mediaType: "image/png",
  filename: "chart.png",
};

afterEach(() => {
  cleanup();
});

describe("MessageAttachmentView", () => {
  it("opens a lightbox with a download link for images", async () => {
    const user = userEvent.setup();
    render(<MessageAttachmentView data={image} />);

    await user.click(screen.getByRole("button", { name: /view chart\.png/i }));

    const download = await screen.findByRole("link", { name: /download chart\.png/i });
    expect(download).toHaveAttribute("href", "/api/attachments/att_1?download=1");
  });

  it("links non-image files through the download URL", () => {
    render(
      <MessageAttachmentView
        data={{
          type: "file",
          url: "/api/attachments/att_2",
          mediaType: "application/pdf",
          filename: "notes.pdf",
        }}
      />,
    );

    expect(screen.getByRole("link", { name: /download notes\.pdf/i })).toHaveAttribute(
      "href",
      "/api/attachments/att_2?download=1",
    );
  });
});
