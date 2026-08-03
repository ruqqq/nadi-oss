// @vitest-environment jsdom
import { useState } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { ProjectsPanel } from "./ProjectsPanel";
import type { ProjectSummary } from "../../projects-api";
import type { ThreadSummary } from "../../threads-api";
import { mergeThreads } from "../../lib/thread-events";

// jsdom has no matchMedia; useMediaQuery reads it synchronously on mount.
// Mobile path (matches: false for "min-width: 1024px") so the detail pane
// alone renders — no list pane needed for these tests.
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
  vi.unstubAllGlobals();
});

const PROJECT: ProjectSummary = {
  id: "p1",
  workspaceId: "ws_1",
  name: "Project One",
  description: "",
  customInstructions: "",
  defaultWorkbenchId: null,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
};

function thread(over: Partial<ThreadSummary> & { threadId: string }): ThreadSummary {
  return {
    kind: "regular",
    workspaceId: "ws_1",
    agentId: "agent_1",
    provider: "openai-oauth",
    model: "gpt-5.5",
    modelInputModalities: ["text"],
    showReasoning: false,
    reasoningEffort: "medium",
    modelSupportsReasoning: true,
    runtime: "think",
    title: `Thread ${over.threadId}`,
    source: "manual",
    lastMessagePreview: "",
    archivedAt: null,
    readOnly: false,
    status: "active",
    projectId: "p1",
    projectName: "Project One",
    workbenchId: null,
    workbenchName: null,
    workbenchSwitchPending: false,
    resourceProfile: "small",
    automatonId: null,
    automatonName: null,
    automatonNotifyMode: null,
    outcomeDismissedAt: null,
    recentDismissedAt: null,
    repositorySnapshotCount: 0,
    createdAt: 1,
    updatedAt: 1,
    lastContextTokens: null,
    lastContextWindow: null,
    lastCompactAfterTokens: null,
    ...over,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Routes the shared global fetch stub across the three endpoints the panel
 *  hits: /api/workbenches (mount), /api/projects/:id (mount, once a project
 *  is selected), and /api/threads (the Chats tab's useThreadQuery). Only the
 *  threads route is interesting per test — the others are fixed boilerplate
 *  every test needs regardless of what it's asserting. */
function buildFetch(onThreads: (url: string) => Response | Promise<Response>) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("/api/threads")) return Promise.resolve(onThreads(url));
    if (url.startsWith("/api/workbenches")) {
      return Promise.resolve(jsonResponse({ workbenches: [] }));
    }
    if (url.startsWith("/api/projects/")) {
      return Promise.resolve(jsonResponse({ project: PROJECT }));
    }
    return Promise.resolve(jsonResponse({}));
  });
}

function baseProps(overrides: Partial<React.ComponentProps<typeof ProjectsPanel>> = {}) {
  return {
    projects: [PROJECT],
    threads: [] as ThreadSummary[],
    onThreadsLoaded: vi.fn(),
    onProjectsChange: vi.fn(),
    selectedId: "p1",
    onSelect: vi.fn(),
    onBackToList: vi.fn(),
    onSelectThread: vi.fn(),
    onManageWorkbenches: vi.fn(),
    closeLabel: "Close",
    onClose: vi.fn(),
    ...overrides,
  };
}

// Mirrors App's own `mergeThreadsPage` wiring: `onThreadsLoaded` merges a
// fetched page into the shared array by id, same as the real parent does.
// Needed wherever a test must observe a SECOND page's rows actually landing
// in `projectThreads` (a plain mock `onThreadsLoaded` never feeds back into
// the `threads` prop).
function ControlledProjectsPanel(
  props: Omit<React.ComponentProps<typeof ProjectsPanel>, "threads" | "onThreadsLoaded"> & {
    initialThreads: ThreadSummary[];
  },
) {
  const { initialThreads, ...rest } = props;
  const [threads, setThreads] = useState<ThreadSummary[]>(initialThreads);
  return (
    <ProjectsPanel
      {...rest}
      threads={threads}
      onThreadsLoaded={(page) => setThreads((current) => mergeThreads(current, page))}
    />
  );
}

/** The panel opens on Configure; the Chats query is gated on that tab being
 *  open, so every test that wants it to fetch has to switch there first. */
function openChatsTab() {
  // Radix's TabsTrigger switches on `onMouseDown`, not `onClick` — a plain
  // fireEvent.click (a single synthetic "click", no preceding mousedown)
  // leaves the Configure tab selected.
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Chats" }), { button: 0 });
}

describe("ProjectsPanel chats tab", () => {
  it("merges a fetched page into the shared array — it does not own the data", async () => {
    const fetchMock = buildFetch(() =>
      jsonResponse({ threads: [thread({ threadId: "b" })], nextCursor: null }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const onThreadsLoaded = vi.fn();
    render(<ProjectsPanel {...baseProps({ threads: [thread({ threadId: "a" })], onThreadsLoaded })} />);
    openChatsTab();

    await waitFor(() => {
      expect(onThreadsLoaded).toHaveBeenCalledWith([expect.objectContaining({ threadId: "b" })]);
    });
  });

  it("does not claim the project has no chats while page one is still in flight", async () => {
    // What this actually guards: the pre-task regression where the empty
    // copy was gated on `projectThreads.length === 0` alone, so it rendered
    // synchronously before any fetch had a chance to run. It does NOT
    // isolate the `exhausted` clause of `isThreadListEmpty` — at `count ===
    // 0`, `!loading && !exhausted` exists only in the window between a
    // commit and its passive-effect flush, so it is not observable through
    // the DOM here; `waitFor` retries until it lands on a passing frame,
    // which is always one where `loading === true`, so this test is green
    // whether the call site passes `exhausted: true`, `exhausted: false`, or
    // deletes the clause entirely. See task-8-report.md's "Test 2" section
    // for the mutation evidence. The `exhausted` clause itself IS guarded,
    // at the unit level, by `isThreadListEmpty`'s own tests in
    // `web/src/lib/thread-list-state.test.ts` — that's where the real
    // coverage lives, not here.
    const fetchMock = buildFetch(() => jsonResponse({ threads: [], nextCursor: "c1" }));
    vi.stubGlobal("fetch", fetchMock);

    render(<ProjectsPanel {...baseProps({ threads: [] })} />);
    openChatsTab();

    await waitFor(() => {
      expect(screen.getByText("Loading chats…")).toBeTruthy();
    });
    expect(screen.queryByText(/No chats in this project yet/)).toBeNull();
  });

  it("a page-one failure over a non-empty list surfaces the error and keeps the rows", async () => {
    // Seed well above CHATS_PAGE_SIZE (25) so `chats.hasMore` is true — a
    // single-row fixture lands in the branch that already works and proves
    // nothing about the inline-vs-full-screen error routing.
    const manyThreads = Array.from({ length: 30 }, (_, i) => thread({ threadId: `t${i}` }));
    const fetchMock = buildFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    vi.stubGlobal("fetch", fetchMock);

    render(<ProjectsPanel {...baseProps({ threads: manyThreads })} />);
    openChatsTab();

    await waitFor(() => {
      expect(screen.getByText("You're offline. Reconnect to load chats.")).toBeTruthy();
    });
    expect(screen.getByText("Thread t0")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Show \d+ more chats?/ })).toBeTruthy();

    // The inline error row (rendered alongside the rows, not the full-screen
    // box) has its own Retry button — a separate surface from test 4's full-
    // screen Retry, with no coverage otherwise. Click it and assert a second
    // /api/threads call fires.
    const retryButton = screen.getByRole("button", { name: /retry/i });
    fireEvent.click(retryButton);

    await waitFor(() => {
      const threadsCalls = fetchMock.mock.calls.filter(([input]) =>
        (typeof input === "string" ? input : input.toString()).startsWith("/api/threads"),
      );
      expect(threadsCalls.length).toBe(2);
    });
  });

  it("recovers from a failure via Retry", async () => {
    let call = 0;
    const fetchMock = buildFetch(() => {
      call += 1;
      if (call === 1) return Promise.reject(new TypeError("Failed to fetch"));
      return Promise.resolve(jsonResponse({ threads: [thread({ threadId: "a" })], nextCursor: null }));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ControlledProjectsPanel {...baseProps({})} initialThreads={[]} />);
    openChatsTab();

    await waitFor(() => {
      expect(screen.getByText("You're offline. Reconnect to load chats.")).toBeTruthy();
    });

    const retryButton = screen.getByRole("button", { name: /try again/i });
    fireEvent.click(retryButton);

    await waitFor(() => {
      expect(screen.queryByText("You're offline. Reconnect to load chats.")).toBeNull();
    });
    expect(screen.getByText("Thread a")).toBeTruthy();
    // Two threads calls: the failed page one, and the retried page one. Env
    // and project calls also hit fetchMock, so assert via the threads route
    // specifically rather than fetchMock's total call count.
    const threadsCalls = fetchMock.mock.calls.filter(([input]) =>
      (typeof input === "string" ? input : input.toString()).startsWith("/api/threads"),
    );
    expect(threadsCalls.length).toBe(2);
  });

  it("keeps paging past a page that adds zero new rows, until the query is exhausted", async () => {
    // Uses ControlledProjectsPanel (real mergeThreads) with a seeded thread
    // "a" already present, so the two duplicate pages below are a genuine
    // no-op through the merge path — not a permanently-empty `threads` prop
    // that would add zero rows regardless of whether the pages are actually
    // duplicates.
    let call = 0;
    const fetchMock = buildFetch(() => {
      call += 1;
      if (call === 1) return jsonResponse({ threads: [thread({ threadId: "a" })], nextCursor: "c1" });
      if (call === 2) return jsonResponse({ threads: [thread({ threadId: "a" })], nextCursor: "c2" });
      return jsonResponse({ threads: [], nextCursor: null });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ControlledProjectsPanel {...baseProps({})} initialThreads={[thread({ threadId: "a" })]} />);
    openChatsTab();

    await waitFor(() => {
      const threadsCalls = fetchMock.mock.calls.filter(([input]) =>
        (typeof input === "string" ? input : input.toString()).startsWith("/api/threads"),
      );
      expect(threadsCalls.length).toBe(3);
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    const threadsCalls = fetchMock.mock.calls.filter(([input]) =>
      (typeof input === "string" ? input : input.toString()).startsWith("/api/threads"),
    );
    expect(threadsCalls.length).toBe(3);
  });

  it("does not fetch while the Configure tab is open", async () => {
    const fetchMock = buildFetch(() => jsonResponse({ threads: [], nextCursor: null }));
    vi.stubGlobal("fetch", fetchMock);

    render(<ProjectsPanel {...baseProps({ threads: [] })} />);

    // Give any stray effect a chance to fire before asserting the negative.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const threadsCalls = fetchMock.mock.calls.filter(([input]) =>
      (typeof input === "string" ? input : input.toString()).startsWith("/api/threads"),
    );
    expect(threadsCalls.length).toBe(0);
  });
});
