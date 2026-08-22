// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadArtifactsSheet } from "./ThreadArtifactsSheet";
import { listThreadArtifacts } from "../../artifacts-api";

vi.mock("../../artifacts-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../artifacts-api")>();
  return {
    ...actual,
    listThreadArtifacts: vi.fn(),
  };
});

const list = vi.mocked(listThreadArtifacts);

beforeEach(() => {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
});

beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn(() => false) as never;
  Element.prototype.setPointerCapture = vi.fn() as never;
  Element.prototype.releasePointerCapture = vi.fn() as never;
  Element.prototype.scrollIntoView = vi.fn() as never;
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as never;
  }
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ThreadArtifactsSheet", () => {
  it("shows an empty state when the thread has nothing published", async () => {
    list.mockResolvedValue({ artifacts: [], downloads: [] });
    render(<ThreadArtifactsSheet open onOpenChange={() => undefined} threadId="thr_1" />);

    expect(await screen.findByText("Nothing published in this chat yet.")).toBeInTheDocument();
    expect(list).toHaveBeenCalledWith("thr_1");
  });

  it("renders published artifacts and committed downloads", async () => {
    list.mockResolvedValue({
      artifacts: [
        {
          id: "art_1",
          title: "Usage dashboard",
          entryPath: "index.html",
          fileCount: 3,
          byteSize: 28_400,
          expiresAt: Date.now() + 86_400_000,
          status: "active",
          url: "/api/artifacts/art_1",
          createdAt: 1,
        },
      ],
      downloads: [
        {
          id: "att_1",
          filename: "notes.pdf",
          mimeType: "application/pdf",
          byteSize: 1_024,
          url: "/api/attachments/att_1",
          createdAt: 2,
        },
      ],
    });
    render(<ThreadArtifactsSheet open onOpenChange={() => undefined} threadId="thr_1" />);

    expect(await screen.findByText("Usage dashboard")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /download notes\.pdf/i })).toHaveAttribute(
      "href",
      "/api/attachments/att_1?download=1",
    );
  });

  it("surfaces a load error without a status code", async () => {
    list.mockRejectedValue(new Error("Couldn't load this chat's artifacts."));
    render(<ThreadArtifactsSheet open onOpenChange={() => undefined} threadId="thr_1" />);

    expect(await screen.findByText("Couldn't load this chat's artifacts.")).toBeInTheDocument();
  });
});
