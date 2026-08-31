// @vitest-environment jsdom
import { useState } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { AllChatsView } from "./App";
import type { ThreadSummary } from "./threads-api";
import { mergeThreads } from "./lib/thread-events";

// jsdom has no matchMedia; useMediaQuery reads it synchronously on mount.
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

function thread(over: Partial<ThreadSummary> & { threadId: string }): ThreadSummary {
  return {
    kind: "regular",
    workspaceId: "ws_1",
    agentId: "agent_1",
    provider: "openai-oauth",
    model: "gpt-5.5",
    modelInputModalities: ["text"],
    reasoningEffort: "medium",
    modelSupportsReasoning: true,
    runtime: "think",
    title: `Thread ${over.threadId}`,
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

function baseProps(overrides: Partial<React.ComponentProps<typeof AllChatsView>> = {}) {
  return {
    threads: [] as ThreadSummary[],
    onThreadsLoaded: vi.fn(),
    projects: [],
    disabled: false,
    showArchived: false,
    onShowArchivedChange: vi.fn(),
    onSelectThread: vi.fn(),
    onArchiveThread: vi.fn(),
    onDeleteThread: vi.fn(),
    onMarkThreadRead: vi.fn(),
    onBack: vi.fn(),
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("AllChatsView active half", () => {
  it("merges its fetched page into the shared array — it does not own the data", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse({ threads: [thread({ threadId: "b" })], nextCursor: null })),
    );
    vi.stubGlobal("fetch", fetchMock);

    const onThreadsLoaded = vi.fn();
    render(<AllChatsView {...baseProps({ threads: [thread({ threadId: "a" })], onThreadsLoaded })} />);

    await waitFor(() => {
      expect(onThreadsLoaded).toHaveBeenCalledWith([expect.objectContaining({ threadId: "b" })]);
    });
  });
});

describe("AllChatsView archived half", () => {
  it("NEVER merges an archived page into the shared array", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse({ threads: [thread({ threadId: "arch1", status: "archived" })], nextCursor: null }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const onThreadsLoaded = vi.fn();
    render(<AllChatsView {...baseProps({ showArchived: true, onThreadsLoaded })} />);

    await waitFor(() => {
      expect(screen.getByText(`Thread arch1`)).toBeTruthy();
    });
    expect(onThreadsLoaded).not.toHaveBeenCalled();
  });
});

describe("AllChatsView empty state", () => {
  it("does not claim there are no chats while page one is still in flight", async () => {
    // What this actually guards: a regression where the empty copy is gated
    // on the shared array's length alone, so it renders synchronously before
    // any fetch had a chance to run. It does NOT isolate the `exhausted`
    // clause of `isThreadListEmpty` — at `count === 0`, `!loading &&
    // !exhausted` exists only in the window between a commit and its
    // passive-effect flush, so it is not observable through the DOM here;
    // `waitFor` retries until it lands on a passing frame, which is always
    // one where `loading === true`, so this test is green whether the call
    // site passes `exhausted: true`, `exhausted: false`, or deletes the
    // clause entirely. See task-8-report.md's "Test 2" section for the
    // mutation evidence (verified against this exact test). The `exhausted`
    // clause itself IS guarded, at the unit level, by `isThreadListEmpty`'s
    // own tests in `web/src/lib/thread-list-state.test.ts` — that's where
    // the real coverage lives, not here.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse({ threads: [], nextCursor: "c1" }))),
    );

    render(<AllChatsView {...baseProps({ threads: [] })} />);

    await waitFor(() => {
      expect(screen.getByText("Loading chats…")).toBeTruthy();
    });
    expect(screen.queryByText("No chats yet.")).toBeNull();
  });
});

describe("AllChatsView error state", () => {
  it("renders a failed fetch's message instead of a latched spinner", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("Server error", { status: 500 }))),
    );

    render(<AllChatsView {...baseProps({ threads: [] })} />);

    await waitFor(() => {
      expect(screen.getByText("Server error")).toBeTruthy();
    });
    expect(screen.queryByText("Loading chats…")).toBeNull();
  });

  it("a failed page fetch does not wipe an already-loaded list", async () => {
    // Reachable scenario: offline, All chats open, the shared array already
    // populated (bootstrap cache). A page fetch rejects. The rows must stay
    // on screen with an inline error, not vanish behind a full-screen error
    // box that would blank 130 rendered chats and lose scroll position.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );

    render(<AllChatsView {...baseProps({ threads: [thread({ threadId: "a" })] })} />);

    // Wait for the query to actually settle into its error state first — the
    // thread row is present from the very first render (it comes from the
    // `threads` prop, not the fetch), so asserting on it before the error
    // lands would pass even if a failed fetch later wiped the list.
    await waitFor(() => {
      expect(screen.getByText("You're offline. Reconnect to load chats.")).toBeTruthy();
    });
    expect(screen.getByText("Thread a")).toBeTruthy();
  });

  it("surfaces a page-one failure even when the render budget still has rows to show", async () => {
    // Reachable scenario the original Critical was filed for: offline, All
    // chats open, bootstrap cache holds MORE than ALL_CHATS_PAGE_SIZE (25)
    // threads. The render budget still has unrevealed rows, so
    // `paged.hasMore` is true and `ShowMoreRow` renders — but the active
    // query's own page-one fetch (fired on mount regardless of the budget)
    // has failed. Seeding only one thread (as the sibling test above does)
    // makes `paged.hasMore` false and lands in the branch that already
    // works; that fixture can't tell this bug apart from a fixed one.
    const manyThreads = Array.from({ length: 30 }, (_, i) => thread({ threadId: `t${i}` }));
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );

    render(<AllChatsView {...baseProps({ threads: manyThreads })} />);

    await waitFor(() => {
      expect(screen.getByText("You're offline. Reconnect to load chats.")).toBeTruthy();
    });
    expect(screen.getByRole("button", { name: /Show \d+ more chats?/ })).toBeTruthy();
  });

  it("recovers from a page-one failure via a Retry affordance (full-screen box)", async () => {
    // Nothing but a key/enabled change (project filter, Active<->Archived
    // toggle, leaving and re-entering the screen) currently clears `error` —
    // there is no retry affordance on the error surface itself. Prove a
    // Retry control exists, that clicking it clears the error, AND that it
    // actually re-fires a fetch (not just a UI reset).
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(jsonResponse({ threads: [thread({ threadId: "a" })], nextCursor: null }));
    vi.stubGlobal("fetch", fetchMock);

    render(<ControlledAllChats {...baseProps({})} initialThreads={[]} />);

    await waitFor(() => {
      expect(screen.getByText("You're offline. Reconnect to load chats.")).toBeTruthy();
    });

    const retryButton = screen.getByRole("button", { name: /try again/i });
    fireEvent.click(retryButton);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.queryByText("You're offline. Reconnect to load chats.")).toBeNull();
    });
    expect(screen.getByText("Thread a")).toBeTruthy();
  });

  it("recovers from a mid-scroll failure via a Retry affordance (inline row)", async () => {
    // The non-empty-list case: the inline error row (alongside ShowMoreRow,
    // per the existing gate) must also offer recovery, not just the
    // full-screen box. Seeding a populated `threads` prop routes past the
    // full-screen branch (`query.error !== null && visibleThreads.length === 0`).
    const fetchMock = vi.fn(() => Promise.reject(new TypeError("Failed to fetch")));
    vi.stubGlobal("fetch", fetchMock);

    render(<AllChatsView {...baseProps({ threads: [thread({ threadId: "a" })] })} />);

    await waitFor(() => {
      expect(screen.getByText("You're offline. Reconnect to load chats.")).toBeTruthy();
    });

    const retryButton = screen.getByRole("button", { name: /retry/i });
    fireEvent.click(retryButton);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});

// Mirrors App's own `mergeThreadsPage` wiring: `onThreadsLoaded` merges a
// fetched page into the shared array by id (mergeThreads), same as the real
// parent does. Without this, a duplicate page could never be reproduced —
// a naive mock `onThreadsLoaded` that doesn't feed back into `threads` would
// leave `visibleThreads.length` changing for reasons that have nothing to do
// with the bug.
function ControlledAllChats(
  props: Omit<React.ComponentProps<typeof AllChatsView>, "threads" | "onThreadsLoaded"> & {
    initialThreads: ThreadSummary[];
  },
) {
  const { initialThreads, ...rest } = props;
  const [threads, setThreads] = useState<ThreadSummary[]>(initialThreads);
  return (
    <AllChatsView
      {...rest}
      threads={threads}
      onThreadsLoaded={(page) => setThreads((current) => mergeThreads(current, page))}
    />
  );
}

describe("AllChatsView row menu", () => {
  async function openMenu(title: string) {
    const trigger = screen.getByLabelText(`Actions for ${title}`);
    fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.pointerUp(trigger, { button: 0 });
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Delete" })).toBeTruthy());
  }

  it("offers Mark as read only while the thread carries an unread outcome", async () => {
    const onMarkThreadRead = vi.fn();
    const unread = thread({
      threadId: "unread",
      title: "Unread one",
      unreadOutcome: "completed",
    });
    const read = thread({ threadId: "read", title: "Read one", unreadOutcome: null });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse({ threads: [unread, read], nextCursor: null }))),
    );

    render(
      <AllChatsView
        {...baseProps({ threads: [unread, read], onMarkThreadRead })}
      />,
    );

    await waitFor(() => expect(screen.getByText("Unread one")).toBeTruthy());
    await openMenu("Read one");
    expect(screen.queryByRole("menuitem", { name: "Mark as read" })).toBeNull();
    fireEvent.keyDown(document.body, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull());
    await openMenu("Unread one");
    fireEvent.click(screen.getByRole("menuitem", { name: "Mark as read" }));
    expect(onMarkThreadRead).toHaveBeenCalledWith("unread");
  });

  it("does not offer Mark as read on the archived tab", async () => {
    const archived = thread({
      threadId: "arch1",
      title: "Archived unread",
      status: "archived",
      unreadOutcome: "completed",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse({ threads: [archived], nextCursor: null }))),
    );

    render(
      <AllChatsView {...baseProps({ showArchived: true, threads: [] })} />,
    );

    await waitFor(() => expect(screen.getByText("Archived unread")).toBeTruthy());
    await openMenu("Archived unread");
    expect(screen.queryByRole("menuitem", { name: "Mark as read" })).toBeNull();
  });
});

describe("AllChatsView dedupe-stall", () => {
  it("keeps paging past a page that adds zero new rows, until the query is exhausted", async () => {
    // Page 1: one row, more pages exist (non-null cursor).
    // Page 2: the SAME row (100% duplicate — mergeThreads adds nothing),
    // still more pages exist. This is the exact case the load-more effect's
    // comment claims to handle: a no-op page must not stall the fetch loop.
    // Page 3: exhausts the query. Reaching this call is the only proof the
    // effect actually re-fired after a no-op page.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ threads: [thread({ threadId: "a" })], nextCursor: "c1" }))
      .mockResolvedValueOnce(jsonResponse({ threads: [thread({ threadId: "a" })], nextCursor: "c2" }))
      .mockResolvedValueOnce(jsonResponse({ threads: [], nextCursor: null }));
    vi.stubGlobal("fetch", fetchMock);

    render(<ControlledAllChats {...baseProps({})} initialThreads={[]} />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    // Termination, not just progress: without this a broken guard that kept
    // re-firing after exhaustion (a 4th, 5th, ... call) would still pass the
    // assertion above. Flush any further microtask/effect churn, then prove
    // the loop actually stopped at 3.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
