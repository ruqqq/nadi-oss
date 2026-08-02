// @vitest-environment jsdom
import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OfflineProvider } from "@/lib/use-offline";

const recover = vi.hoisted(() => vi.fn(() => Promise.resolve("recovering" as const)));
vi.mock("@/lib/stale-bundle", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stale-bundle")>()),
  recoverFromStaleBundle: recover,
}));
const evict = vi.hoisted(() => vi.fn());
vi.mock("@/lib/thread-history", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/thread-history")>()),
  evictThreadHistory: evict,
}));

import { ThreadHistoryErrorBoundary, ThreadHistoryUnavailable } from "./ThreadHistoryErrorBoundary";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderFallback(
  reachability: "reachable" | "unreachable",
  props: { onRetry?: () => void; header?: ReactNode } = {},
) {
  return render(
    <OfflineProvider reachability={reachability}>
      <ThreadHistoryUnavailable onRetry={props.onRetry ?? (() => {})} header={props.header} />
    </OfflineProvider>,
  );
}

describe("ThreadHistoryUnavailable", () => {
  it("says 'offline' when the app is offline", () => {
    renderFallback("unreachable");
    expect(screen.getByText("This conversation isn't available offline")).toBeTruthy();
  });

  it("does not blame offline when the app is online (a transient failure)", () => {
    renderFallback("reachable");
    expect(screen.getByText("Couldn't load this conversation")).toBeTruthy();
    expect(screen.queryByText(/available offline/)).toBeNull();
  });

  it("renders the header (which carries the context-aware back/rail control)", () => {
    renderFallback("unreachable", {
      header: <button type="button">Show chats</button>,
    });
    expect(screen.getByRole("button", { name: "Show chats" })).toBeTruthy();
  });

  it("retries when Try again is pressed", async () => {
    const onRetry = vi.fn();
    renderFallback("unreachable", { onRetry });
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("auto-retries once when connectivity returns", () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <OfflineProvider reachability="unreachable">
        <ThreadHistoryUnavailable onRetry={onRetry} />
      </OfflineProvider>,
    );
    expect(onRetry).not.toHaveBeenCalled();
    // Back online → the boundary retries itself.
    rerender(
      <OfflineProvider reachability="reachable">
        <ThreadHistoryUnavailable onRetry={onRetry} />
      </OfflineProvider>,
    );
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("does not auto-retry a failure that happened while online", () => {
    const onRetry = vi.fn();
    render(
      <OfflineProvider reachability="reachable">
        <ThreadHistoryUnavailable onRetry={onRetry} />
      </OfflineProvider>,
    );
    expect(onRetry).not.toHaveBeenCalled();
  });
});

function Boom({ error }: { error: Error }): never {
  throw error;
}

function renderBoundary(error: Error) {
  return render(
    <OfflineProvider reachability="reachable">
      <ThreadHistoryErrorBoundary threadId="thr_1" onRetry={() => {}}>
        <Boom error={error} />
      </ThreadHistoryErrorBoundary>
    </OfflineProvider>,
  );
}

describe("ThreadHistoryErrorBoundary", () => {
  beforeEach(() => {
    recover.mockClear();
    evict.mockClear();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("recovers onto the new build when the ChatLog chunk is gone, instead of blaming the chat", () => {
    // The reported bug: a deploy under an open tab rendered "Couldn't load this
    // conversation", whose Try again re-imports the same dead URL forever.
    renderBoundary(
      new Error("Failed to fetch dynamically imported module: /assets/ChatLog-a1b2.js"),
    );
    expect(recover).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Nadi was updated")).toBeTruthy();
    expect(screen.queryByText("Couldn't load this conversation")).toBeNull();
  });

  it("still shows the history fallback for an ordinary load failure", () => {
    renderBoundary(new Error("Failed to fetch"));
    expect(recover).not.toHaveBeenCalled();
    expect(screen.getByText("Couldn't load this conversation")).toBeTruthy();
    expect(evict).toHaveBeenCalledWith("thr_1");
  });
});
