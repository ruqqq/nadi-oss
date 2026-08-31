// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import type { ThreadSummary } from "./threads-api";

const createNewThread = vi.fn();
const listWorkbenches = vi.fn();
let resolveCreate: ((thread: ThreadSummary) => void) | null = null;
let rejectCreate: ((error: Error) => void) | null = null;

vi.mock("./lib/new-thread-send", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/new-thread-send")>()),
  createNewThread: (...args: unknown[]) => createNewThread(...args),
}));

vi.mock("./workbenches-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./workbenches-api")>()),
  listWorkbenches: (...args: unknown[]) => listWorkbenches(...args),
}));

// Seeds the new-chat provider/model synchronously on mount, so the composer is
// sendable without waiting on a bootstrap round trip.
vi.mock("./lib/bootstrap-cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/bootstrap-cache")>()),
  readCachedBootstrap: () => ({
    settings: {
      agent: {
        provider: "openai-oauth",
        model: "gpt-5.5",
        modelInputModalities: ["text"],
      },
      providers: [{ provider: "openai-oauth", usable: true }],
    },
  }),
}));

import { ChatApp } from "./App";

const WORKBENCH = {
  id: "wb_1",
  workspaceId: "ws_1",
  name: "Nadi",
  description: "",
  setupScript: "",
  repositories: [],
  envVars: {},
  secretEnvNames: [],
  networkDomainAllowlist: "",
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
};

const CREATED_THREAD = {
  kind: "regular",
  threadId: "thr_new",
  workspaceId: "ws_1",
  agentId: "agent_1",
  provider: "openai-oauth",
  model: "gpt-5.5",
  modelInputModalities: ["text"],
  runtime: "think",
  title: "New thread",
  source: "manual",
  lastMessagePreview: "",
  archivedAt: null,
  readOnly: false,
  status: "active",
  projectId: null,
  projectName: null,
  workbenchId: null,
  workbenchName: null,
  workbenchSwitchPending: false,
  resourceProfile: "small",
  automatonId: null,
  automatonName: null,
  automatonNotifyMode: null,
  outcomeDismissedAt: null,
  repositorySnapshotCount: 0,
  createdAt: 1,
  updatedAt: 1,
  lastContextTokens: null,
  lastContextWindow: null,
  lastCompactAfterTokens: null,
} as ThreadSummary;

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  window.matchMedia = (query: string) =>
    ({
      matches: false, // desktop
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
  Element.prototype.scrollIntoView = vi.fn() as never;
  Element.prototype.hasPointerCapture = vi.fn(() => false) as never;
  Element.prototype.setPointerCapture = vi.fn() as never;
  Element.prototype.releasePointerCapture = vi.fn() as never;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // No network: nothing else may resolve and re-create callbacks behind our back.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>(() => {})),
  );
  listWorkbenches.mockResolvedValue([WORKBENCH]);
  createNewThread.mockReturnValue(
    new Promise<ThreadSummary>((resolve, reject) => {
      resolveCreate = resolve;
      rejectCreate = reject;
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  resolveCreate = null;
  rejectCreate = null;
});

function renderApp() {
  render(
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
    />,
  );
}

describe("new-chat workbench selection", () => {
  // Regression guard for a stale-closure bug: `createAndSend` listed
  // `workbenches` in its dependency array but NOT `newChatWorkbenchId`, so on a
  // fresh launch the callback kept the mount-time "none" and dropped the user's
  // choice from the POST. It self-healed once any other dependency changed,
  // which is why only the FIRST thread of each launch lost its workbench —
  // so this test must send on a freshly mounted app and never re-render first.
  it("sends the picked workbench on the first thread after mount", async () => {
    renderApp();

    // Wait for the workbench list to land, so the picker can offer it.
    await waitFor(() => expect(listWorkbenches).toHaveBeenCalled());

    // Open the hero composer. This only flips draft state — it must not
    // recreate `createAndSend`, which is precisely what the bug relied on.
    fireEvent.click(screen.getAllByRole("button", { name: /new chat/i })[0]!);

    // Radix's popover trigger opens on pointerdown, not click.
    const picker = await screen.findByRole("button", { name: /workbench: inherit/i });
    fireEvent.pointerDown(picker, { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(picker);
    // "Nadi" is also the app's brand heading — scope to the picker's list.
    fireEvent.click(await screen.findByRole("option", { name: /Nadi/ }));

    const input = screen.getByPlaceholderText(/message/i);
    fireEvent.change(input, { target: { value: "hello" } });
    const form = input.closest("form");
    if (!form) throw new Error("composer form not found");
    fireEvent.submit(form);

    await waitFor(() => expect(createNewThread).toHaveBeenCalled());
    expect(createNewThread.mock.calls[0]?.[1]).toMatchObject({ workbenchId: "wb_1" });
  });
});

describe("pending new-chat projection", () => {
  it("shows the submitted message with a sending indicator before thread creation resolves", async () => {
    renderApp();

    fireEvent.click(screen.getAllByRole("button", { name: /new chat/i })[0]!);
    const input = screen.getByPlaceholderText(/message/i);
    fireEvent.change(input, { target: { value: "hello from a slow connection" } });
    const form = input.closest("form");
    if (!form) throw new Error("composer form not found");
    fireEvent.submit(form);

    await waitFor(() => expect(createNewThread).toHaveBeenCalled());

    expect(window.location.pathname).toBe("/");
    expect(screen.getByText("hello from a slow connection")).toBeTruthy();
    // Delivery progress stays on the bubble; the typing dots are the assistant
    // affordance and must appear immediately — before the thread (or stream)
    // exists — so the optimistic view feels like a live turn.
    expect(screen.getByText(/Sending/i)).toBeTruthy();
    expect(screen.getByRole("status", { name: "Nadi is responding" })).toBeTruthy();
    // The pending projection carries the same disabled composer shell as the
    // history-loading skeleton, so the composer no longer pops in as the surface
    // swaps under the optimistic bubble — but it can't be typed into until the
    // thread is live.
    const pendingComposer = screen.getByPlaceholderText(/message/i);
    expect((pendingComposer as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.queryByText(/Queued/i)).toBeNull();
  });

  it("hands the created thread to routing without refetching it", async () => {
    renderApp();

    fireEvent.click(screen.getAllByRole("button", { name: /new chat/i })[0]!);
    const input = screen.getByPlaceholderText(/message/i);
    fireEvent.change(input, { target: { value: "handoff without a route reload" } });
    const form = input.closest("form");
    if (!form) throw new Error("composer form not found");
    fireEvent.submit(form);

    await screen.findByRole("status", { name: "Nadi is responding" });
    await act(async () => resolveCreate?.(CREATED_THREAD));

    await waitFor(() => expect(window.location.pathname).toBe("/threads/thr_new"));

    const requestedPaths = vi.mocked(fetch).mock.calls.map(([input]) => {
      const raw = input instanceof Request ? input.url : String(input);
      return new URL(raw, window.location.origin).pathname;
    });
    expect(requestedPaths).not.toContain("/api/threads/thr_new");
  });

  it("restores the submitted draft when thread creation fails", async () => {
    renderApp();

    fireEvent.click(screen.getAllByRole("button", { name: /new chat/i })[0]!);
    const input = screen.getByPlaceholderText(/message/i);
    fireEvent.change(input, { target: { value: "keep this draft" } });
    const form = input.closest("form");
    if (!form) throw new Error("composer form not found");
    fireEvent.submit(form);

    await screen.findByRole("status", { name: "Nadi is responding" });
    await act(async () => rejectCreate?.(new Error("slow network failed")));

    const restored = await screen.findByPlaceholderText(/message/i);
    expect(restored).toHaveProperty("value", "keep this draft");
    // Back on the live hero composer, not the pending projection's disabled shell.
    expect((restored as HTMLTextAreaElement).disabled).toBe(false);
    expect(screen.queryByRole("status", { name: "Nadi is responding" })).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("slow network failed");
    expect(window.location.pathname).toBe("/");
  });
});
