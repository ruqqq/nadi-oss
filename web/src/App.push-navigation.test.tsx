// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { ChatApp } from "./App";
import { savePendingThreadNavigation } from "./lib/pending-navigation";

// ChatApp opens the user-hub socket on mount; jsdom has no server to talk to.
const live = vi.hoisted(() => ({
  socket: {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
    reconnect: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  },
}));

vi.mock("./lib/user-hub-socket", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/user-hub-socket")>()),
  openUserHubSocket: vi.fn(() => live.socket),
}));

beforeEach(() => {
  indexedDB = new IDBFactory();
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
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // Nothing needs to land for the routing assertions below.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>(() => {})),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderChatApp(path: string) {
  window.history.replaceState(null, "", path);
  return render(
    <ChatApp
      consentWorkspaceId={null}
      user={{ id: "u1", email: "you@example.com" } as never}
      initialProjects={[]}
      initialThreads={[]}
      initialThreadsNextCursor={null}
      onActiveWorkspaceChange={() => {}}
      onSignOut={() => {}}
      voiceEnabled={false}
      backgroundWorkEnabled={false}
      feedbackAdminEnabled={false}
    />,
  );
}

describe("push notification launch routing", () => {
  it("opens the tapped thread on launch, even though the app starts at start_url", async () => {
    // What a notification tap on an installed PWA actually looks like: the OS
    // restores the app at "/" and the service worker has left the target
    // behind, because its postMessage cannot be relied on to be heard.
    await savePendingThreadNavigation("thr_tapped");

    renderChatApp("/");

    await waitFor(() => expect(window.location.pathname).toBe("/threads/thr_tapped"));
  });

  it("opens the tapped thread on resume, without a remount", async () => {
    renderChatApp("/");
    await waitFor(() => expect(window.location.pathname).toBe("/"));

    await savePendingThreadNavigation("thr_tapped");
    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() => expect(window.location.pathname).toBe("/threads/thr_tapped"));
  });

  it("still opens the thread when the worker writes the record after the app boots", async () => {
    // The page and the worker race: a tap launches the app AND fires
    // notificationclick, in no guaranteed order. A one-shot claim on mount
    // loses whenever the boot wins.
    renderChatApp("/");
    await waitFor(() => expect(window.location.pathname).toBe("/"));

    await new Promise((resolve) => setTimeout(resolve, 400));
    await savePendingThreadNavigation("thr_late");

    await waitFor(() => expect(window.location.pathname).toBe("/threads/thr_late"), {
      timeout: 5_000,
    });
  });

  it("opens the thread when the worker writes the record after the app resumes", async () => {
    // The reported failure. On a resume the OS foregrounds the app first and
    // wakes the worker after, so the resume signal arrives BEFORE the record
    // exists — and nothing remounts, so a one-shot claim never looks again.
    renderChatApp("/");
    await waitFor(() => expect(window.location.pathname).toBe("/"));
    // Past the mount window, so only the resume path can serve this.
    await new Promise((resolve) => setTimeout(resolve, 5_500));

    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((resolve) => setTimeout(resolve, 400));
    await savePendingThreadNavigation("thr_late_resume");

    await waitFor(() => expect(window.location.pathname).toBe("/threads/thr_late_resume"), {
      timeout: 8_000,
    });
  }, 20_000);

  it("leaves the route alone when nothing was tapped", async () => {
    renderChatApp("/");

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(window.location.pathname).toBe("/");
  });

  it("does not replay a claimed tap on the next resume", async () => {
    await savePendingThreadNavigation("thr_tapped");
    renderChatApp("/");
    await waitFor(() => expect(window.location.pathname).toBe("/threads/thr_tapped"));

    // The user walks back out to the chat list, then backgrounds and returns.
    window.history.replaceState(null, "", "/chats");
    document.dispatchEvent(new Event("visibilitychange"));

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(window.location.pathname).toBe("/chats");
  });
});
