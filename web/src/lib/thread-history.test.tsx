// @vitest-environment jsdom

import { Suspense, use, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ThreadHistoryErrorBoundary } from "../components/ThreadHistoryErrorBoundary";
import { threadHistoryKey, useThreadHistoryPromise } from "./thread-history";
import { OfflineProvider } from "./use-offline";

// These tests deliberately render OUTSIDE `act()` with a real `createRoot`.
// `act()` flushes suspend-retries synchronously and masks the retry loop this
// module exists to prevent: a per-mount (useRef) promise cache is discarded by
// React on every suspend-before-commit, so the fetcher runs again on each
// retry — under `renderHook`/`act` that is invisible, in a real root it is a
// hot request loop. Every test here asserts a *fetch count*.
declare const globalThis: { IS_REACT_ACT_ENVIRONMENT?: boolean } & typeof global;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  root.unmount();
  container.remove();
  vi.restoreAllMocks();
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Let React's scheduler run until the DOM says what we expect (suspend-retries
 * are throttled and take a while under jsdom), then keep running a little
 * longer: a retry loop would still be firing fetches after the deadline, which
 * the fetch-count assertions catch.
 */
async function settle(predicate: () => boolean = () => false, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !predicate()) await sleep(20);
  await sleep(100);
}

function text(): string {
  return container.textContent ?? "";
}

function history(): string | undefined {
  return container.querySelector("[data-testid='history']")?.textContent;
}

function History({
  threadId,
  nonce,
  fetcher,
}: {
  threadId: string;
  nonce: number;
  fetcher: () => Promise<string[]>;
}) {
  const messages = use(useThreadHistoryPromise(threadHistoryKey(threadId, nonce), fetcher));
  return <div data-testid="history">{messages.join(",")}</div>;
}

/**
 * Mirrors App.tsx: an error boundary outside a Suspense whose subtree is keyed
 * by `threadId:nonce`, where "Try again" bumps the nonce (here held in state so
 * clicking the real button drives a real retry, as it does in the app).
 */
function Harness({
  threadId,
  nonce,
  fetcher,
  onRetry = () => {},
}: {
  threadId: string;
  nonce: number;
  fetcher: () => Promise<string[]>;
  onRetry?: () => void;
}) {
  const [bumps, setBumps] = useState(0);
  const effective = nonce + bumps;
  // Force the offline copy so the "available offline" assertions hold; the copy
  // is now driven by useOffline() (see ThreadHistoryUnavailable).
  return (
    <OfflineProvider reachability="unreachable">
      <ThreadHistoryErrorBoundary
        threadId={threadId}
        onRetry={() => {
          onRetry();
          setBumps((b) => b + 1);
        }}
      >
        <Suspense fallback={<div data-testid="skeleton">loading</div>}>
          <History
            key={`${threadId}:${effective}`}
            threadId={threadId}
            nonce={effective}
            fetcher={fetcher}
          />
        </Suspense>
      </ThreadHistoryErrorBoundary>
    </OfflineProvider>
  );
}

function clickTryAgain(): void {
  const button = [...container.querySelectorAll("button")].find((b) =>
    /try again/i.test(b.textContent ?? ""),
  );
  expect(button).toBeDefined();
  button?.click();
}

describe("useThreadHistoryPromise", () => {
  it("fetches exactly once per threadId:nonce, surviving suspend-retries", async () => {
    // Against the old per-mount ref cache this fails hard: the ref is thrown
    // away on every suspend-before-commit, so the fetcher is re-invoked on each
    // retry (measured: 23-30 calls in 400ms, never rendering).
    const fetcher = vi.fn(async () => {
      await sleep(20);
      return ["hello"];
    });

    root.render(<Harness threadId="t-once" nonce={0} fetcher={fetcher} />);
    await settle(() => history() !== undefined);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(history()).toBe("hello");
  });

  it("does not refetch when the component re-renders with the same key", async () => {
    const fetcher = vi.fn(async () => ["hello"]);

    root.render(<Harness threadId="t-rerender" nonce={0} fetcher={fetcher} />);
    await settle(() => history() !== undefined);
    root.render(<Harness threadId="t-rerender" nonce={0} fetcher={fetcher} />);
    await settle();

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(history()).toBe("hello");
  });

  it("bumping the nonce performs exactly one new fetch", async () => {
    const fetcher = vi
      .fn<() => Promise<string[]>>()
      .mockResolvedValueOnce(["first"])
      .mockResolvedValueOnce(["second"]);

    root.render(<Harness threadId="t-nonce" nonce={0} fetcher={fetcher} />);
    await settle(() => history() === "first");
    expect(fetcher).toHaveBeenCalledTimes(1);

    root.render(<Harness threadId="t-nonce" nonce={1} fetcher={fetcher} />);
    await settle(() => history() === "second");

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(history()).toBe("second");
  });

  it("surfaces a rejected fetch to the error boundary without looping, and retries on a new nonce", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetcher = vi
      .fn<() => Promise<string[]>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(["back online"]);

    root.render(<Harness threadId="t-retry" nonce={0} fetcher={fetcher} />);
    await settle(() => text().includes("available offline"));

    // One failing fetch, not a storm of them, and the boundary caught it.
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(text()).toContain("This conversation isn't available offline");

    clickTryAgain();
    await settle(() => history() === "back online");

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(history()).toBe("back online");
  });

  it("a failed thread refetches when reopened, even on the same nonce (no session-long wedge)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetcher = vi
      .fn<() => Promise<string[]>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(["back online"]);

    root.render(<Harness threadId="t-wedge" nonce={0} fetcher={fetcher} />);
    await settle(() => text().includes("available offline"));
    expect(text()).toContain("This conversation isn't available offline");

    // Simulate navigating away and back: a fresh boundary + subtree, same nonce.
    root.unmount();
    root = createRoot(container);
    root.render(<Harness threadId="t-wedge" nonce={0} fetcher={fetcher} />);
    await settle(() => history() === "back online");

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(history()).toBe("back online");
  });
});

describe("ThreadHistoryErrorBoundary retry wiring", () => {
  it("calls onRetry when 'Try again' is clicked", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onRetry = vi.fn();
    const fetcher = vi.fn<() => Promise<string[]>>().mockRejectedValue(new Error("offline"));

    root.render(<Harness threadId="t-button" nonce={0} fetcher={fetcher} onRetry={onRetry} />);
    await settle(() => text().includes("available offline"));

    clickTryAgain();
    await settle();

    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
