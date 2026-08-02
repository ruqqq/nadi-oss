// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ActiveWatcher } from "@/lib/watcher-runs";
import { WatcherChip } from "./WatcherChip";

// jsdom has no matchMedia; useMediaQuery reads it synchronously on mount.
// Desktop (Dialog) path: never matches "(max-width: 640px)".
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

afterEach(() => {
  cleanup();
});

function watcher(over: Partial<ActiveWatcher> = {}): ActiveWatcher {
  return {
    processId: "proc_abcdef123456",
    label: "build",
    command: "pnpm build",
    createdAt: 1000,
    deadlineAt: 1000 + 300_000,
    ...over,
  };
}

describe("WatcherChip", () => {
  it("shows the captured output tail once the modal is opened", async () => {
    render(<WatcherChip watcher={watcher({ outputTail: "compiling…\ndone\n" })} nowMs={6000} />);

    await userEvent.click(screen.getByRole("button", { name: /build/i }));

    expect(await screen.findByText("Output")).toBeInTheDocument();
    expect(screen.getByText(/compiling…/)).toBeInTheDocument();
    expect(screen.getByText(/done/)).toBeInTheDocument();
  });

  it("shows a waiting placeholder when there is no output yet", async () => {
    render(<WatcherChip watcher={watcher({ outputTail: undefined })} nowMs={6000} />);

    await userEvent.click(screen.getByRole("button", { name: /build/i }));

    expect(await screen.findByText("Output")).toBeInTheDocument();
    expect(screen.getByText(/waiting for output/i)).toBeInTheDocument();
  });

  it("treats a whitespace-only tail as no output", async () => {
    render(<WatcherChip watcher={watcher({ outputTail: "   \n  " })} nowMs={6000} />);

    await userEvent.click(screen.getByRole("button", { name: /build/i }));

    expect(await screen.findByText(/waiting for output/i)).toBeInTheDocument();
  });
});
