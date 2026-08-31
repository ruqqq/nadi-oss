// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { ChatApp, RailContent } from "./App";
import type { ThreadChatApi, ThreadAgentSocket } from "./thread-chat-seam";
import type { ThreadSummary } from "./threads-api";
import { FINE_POINTER_QUERY } from "./lib/use-fine-pointer";
import { WIDE_LAYOUT_QUERY } from "./lib/use-wide-layout";
import { SIDEBAR_RECENT_THREAD_LIMIT } from "./lib/thread-dismissal";

const live = vi.hoisted(() => {
  let onMessage: ((raw: string) => void) | null = null;
  const listeners = new Map<string, Set<EventListener>>();
  return {
    setMessageHandler(handler: (raw: string) => void) { onMessage = handler; },
    emitMessage(value: unknown) { onMessage?.(JSON.stringify(value)); },
    emitOpen() { for (const listener of listeners.get("open") ?? []) listener(new Event("open")); },
    socket: {
      readyState: WebSocket.OPEN,
      send: vi.fn(), close: vi.fn(), reconnect: vi.fn(),
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        const set = listeners.get(type) ?? new Set<EventListener>();
        set.add(listener); listeners.set(type, set);
      }),
      removeEventListener: vi.fn((type: string, listener: EventListener) => listeners.get(type)?.delete(listener)),
    },
  };
});

vi.mock("./lib/user-hub-socket", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/user-hub-socket")>()),
  openUserHubSocket: vi.fn((onMessage: (raw: string) => void) => {
    live.setMessageHandler(onMessage); return live.socket;
  }),
}));

// jsdom has no matchMedia; useMediaQuery reads it synchronously on mount.
// Desktop path: never matches "(max-width: 767px)".
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

function baseProps(overrides: Partial<React.ComponentProps<typeof RailContent>> = {}) {
  return {
    threads: [] as ThreadSummary[],
    threadsNextCursor: null,
    onThreadsLoaded: vi.fn(),
    activeThreadId: null,
    allChatsActive: false,
    panelKind: null,
    disabled: false,
    loading: false,
    creating: false,
    projects: [],
    onNewThread: vi.fn(),
    onSelectThread: vi.fn(),
    onOpenAllChats: vi.fn(),
    onMarkThreadRead: vi.fn(),
    onDismissThread: vi.fn(),
    onMoveThread: vi.fn(),
    onCreateProject: vi.fn(async () => undefined),
    user: { email: "you@example.com" } as never,
    onOpenProjects: vi.fn(),
    onOpenAutomata: vi.fn(),
    onOpenInvites: vi.fn(),
    inviteQuota: null,
    onOpenFeedback: vi.fn(),
    feedbackAdminEnabled: false,
    onOpenFeedbackInbox: vi.fn(),
    onOpenSettings: vi.fn(),
    onSignOut: vi.fn(),
    ...overrides,
  };
}

describe("RailContent overflow link", () => {
  it("stays hidden with a short list and no next cursor", () => {
    const threads = Array.from({ length: 5 }, (_, i) => thread({ threadId: `t${i}` }));
    render(<RailContent {...baseProps({ threads, threadsNextCursor: null })} />);
    expect(screen.queryByText("Older chats")).toBeNull();
  });

  it("appears when the shared array's own fetch says there is another page, even under the cap", () => {
    // Regression guard for the count-derived version of this link: a raw
    // array-length check would miss this case entirely, since only 5 threads
    // are loaded locally.
    const threads = Array.from({ length: 5 }, (_, i) => thread({ threadId: `t${i}` }));
    render(<RailContent {...baseProps({ threads, threadsNextCursor: "cursor_1" })} />);
    expect(screen.getByText("Older chats")).toBeTruthy();
  });

  it("appears once the merged array exceeds the recent cap, even with no next cursor", () => {
    const threads = Array.from({ length: 16 }, (_, i) => thread({ threadId: `t${i}` }));
    render(<RailContent {...baseProps({ threads, threadsNextCursor: null })} />);
    expect(screen.getByText("Older chats")).toBeTruthy();
  });

  it("never renders a number — the count is unknowable without a COUNT query", () => {
    const threads = Array.from({ length: 20 }, (_, i) => thread({ threadId: `t${i}` }));
    render(<RailContent {...baseProps({ threads, threadsNextCursor: "cursor_1" })} />);
    // The old copy read "N older chats" — assert that shape is gone, not just
    // that some link exists.
    expect(screen.queryByText(/\d+ older/)).toBeNull();
  });
});

describe("RailContent search", () => {
  it("does not claim 'no chats match' while the server search is still in flight", async () => {
    let resolveFetch: (() => void) | undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = () =>
            resolve(
              new Response(JSON.stringify({ threads: [], nextCursor: null }), { status: 200 }),
            );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const threads = [thread({ threadId: "t1", title: "Deploy notes" })];
    render(<RailContent {...baseProps({ threads })} />);

    fireEvent.change(screen.getByPlaceholderText("Search chats"), {
      target: { value: "nonexistent query" },
    });

    // Debounce window (250ms) plus the fetch itself hasn't resolved yet.
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByText(/No chats match/)).toBeNull();

    resolveFetch?.();
    await waitFor(() => {
      expect(screen.getByText(/No chats match/)).toBeTruthy();
    });
  });

  it("does not render the PREVIOUS query's settled empty state while a new query is debouncing", async () => {
    // Regression guard for finding #1: `matches` is keyed on the raw query,
    // `exhausted`/`loading` on the debounced one. Settle a search on "roll",
    // then retype to "xyz" — the raw-query `matches` goes empty instantly,
    // but "roll"'s settled `exhausted: true` must not be read as "xyz"'s
    // answer for the debounce window.
    const responses: Array<{ threads: never[]; nextCursor: null }> = [
      { threads: [], nextCursor: null },
    ];
    const fetchMock = vi.fn(
      () =>
        new Response(JSON.stringify(responses[0]), { status: 200 }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchMock);

    const threads = [thread({ threadId: "t1", title: "roll the dice" })];
    render(<RailContent {...baseProps({ threads })} />);

    const input = screen.getByPlaceholderText("Search chats");
    fireEvent.change(input, { target: { value: "roll" } });

    // Let "roll" settle: debounce (250ms) + the fetch resolving.
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    await new Promise((r) => setTimeout(r, 300));

    // Retype to a query with zero local matches.
    fireEvent.change(input, { target: { value: "xyz" } });

    // Immediately after the keystroke — well within the debounce window —
    // "No chats match" must not appear, because "xyz"'s own search hasn't
    // even fired yet.
    expect(screen.queryByText(/No chats match/)).toBeNull();
  });

  it("renders local matches instantly without waiting on the server fetch", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
    const threads = [
      thread({ threadId: "t1", title: "Deploy notes" }),
      thread({ threadId: "t2", title: "Unrelated" }),
    ];
    render(<RailContent {...baseProps({ threads })} />);

    fireEvent.change(screen.getByPlaceholderText("Search chats"), {
      target: { value: "deploy" },
    });

    expect(screen.getByText("Deploy notes")).toBeTruthy();
    expect(screen.queryByText("Unrelated")).toBeNull();
  });

  it("surfaces a failed search instead of latching 'Searching…' forever", async () => {
    // Regression guard for finding #2: useThreadQuery clears `loading` on a
    // rejected fetch WITHOUT setting `exhausted` — so without reading `error`
    // the rail was stuck on the spinner with no message and no way to retry.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("Server error", { status: 500 }))),
    );

    const threads = [thread({ threadId: "t1", title: "Deploy notes" })];
    render(<RailContent {...baseProps({ threads })} />);

    fireEvent.change(screen.getByPlaceholderText("Search chats"), {
      target: { value: "nonexistent" },
    });

    await waitFor(() => {
      expect(screen.getByText("Server error")).toBeTruthy();
    });
    expect(screen.queryByText(/Searching…/)).toBeNull();
    expect(screen.queryByText(/No chats match/)).toBeNull();
  });
});

describe("RailContent account feedback actions", () => {
  it("shows Send feedback before Settings", async () => {
    const onOpenFeedback = vi.fn();
    const onOpenSettings = vi.fn();
    render(<RailContent {...baseProps({ onOpenFeedback, onOpenSettings })} />);

    const trigger = screen.getByLabelText("Account menu for you@example.com");
    fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.pointerUp(trigger, { button: 0 });

    const items = await screen.findAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["Send feedback", "Settings", "Sign out"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Send feedback" }));
    expect(onOpenFeedback).toHaveBeenCalledTimes(1);
  });

  it("opens Settings without leaking the select event as its tab argument", async () => {
    const onOpenSettings = vi.fn();
    render(<RailContent {...baseProps({ onOpenSettings })} />);
    const trigger = screen.getByLabelText("Account menu for you@example.com");
    fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.pointerUp(trigger, { button: 0 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Settings" }));
    // Must be called with NO arguments — openSettings(tab?) handed Radix's
    // select event would route to "/settings/[object Event]".
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(onOpenSettings.mock.calls[0]).toHaveLength(0);
  });

  it("shows the admin inbox item only for feedback admins", async () => {
    render(<RailContent {...baseProps({ feedbackAdminEnabled: false })} />);
    let trigger = screen.getByLabelText("Account menu for you@example.com");
    fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.pointerUp(trigger, { button: 0 });
    expect(await screen.findByRole("menuitem", { name: "Send feedback" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Feedback inbox" })).toBeNull();

    cleanup();
    const onOpenFeedbackInbox = vi.fn();
    render(
      <RailContent
        {...baseProps({ feedbackAdminEnabled: true, onOpenFeedbackInbox })}
      />,
    );
    trigger = screen.getByLabelText("Account menu for you@example.com");
    fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.pointerUp(trigger, { button: 0 });
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "Send feedback",
      "Feedback inbox",
      "Settings",
      "Sign out",
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Feedback inbox" }));
    expect(onOpenFeedbackInbox).toHaveBeenCalledTimes(1);
  });
});

describe("ChatApp cold-launch cursor seed", () => {
  // Bootstrap now caps the thread list and hands back a cursor. Without
  // seeding threadsNextCursor from it, a cold OFFLINE launch (no network round
  // trip ever lands to fill it in) would silently imply the capped page is the
  // whole list — this guards that the seed reaches the rail on first paint.
  it("shows the 'Older chats' affordance on first paint when seeded with a next cursor", () => {
    // Never resolves — simulates a cold offline launch where no bootstrap
    // revalidation, thread refresh, or notification fetch can land.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );

    const threads = Array.from({ length: 5 }, (_, i) => ({
      threadId: `t${i}`,
      workspaceId: "ws_1",
      agentId: "agent_1",
      provider: "openai-oauth",
      model: "gpt-5.5",
      modelInputModalities: ["text"],
      runtime: "think",
      title: `Thread t${i}`,
      source: "manual",
      lastMessagePreview: "",
      archivedAt: null,
      readOnly: false,
      status: "active",
      projectId: null,
      projectName: null,
      workbenchId: null,
      workbenchName: null,
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
    })) as ThreadSummary[];

    render(
      <ChatApp
        consentWorkspaceId={null}
        user={{ id: "u1", email: "you@example.com" } as never}
        initialProjects={[]}
        initialThreads={threads}
        initialThreadsNextCursor="cursor_1"
        onActiveWorkspaceChange={() => {}}
        onSignOut={() => {}}
        voiceEnabled={false}
        backgroundWorkEnabled={false}
        feedbackAdminEnabled={false}
      />,
    );

    expect(screen.getByText("Older chats")).toBeTruthy();
  });
});

describe("ChatApp feedback route", () => {
  function renderFeedbackRoute() {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    window.history.replaceState(null, "", "/feedback");
    const feedbackThread = thread({
      threadId: "feedback_thread",
      title: "Feedback",
      modelInputModalities: ["text", "image"],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/feedback/thread") {
          return Promise.resolve(Response.json({ thread: feedbackThread }));
        }
        if (url === "/think-agents/think-thread-agent/feedback_thread/get-messages") {
          return Promise.resolve(Response.json({ messages: [] }));
        }
        if (url === "/api/invites") {
          return Promise.resolve(
            Response.json({ invites: [], quota: { used: 0, limit: 5 }, isSuperuser: false, waitingList: [] }),
          );
        }
        if (url.startsWith("/api/workbenches")) {
          return Promise.resolve(Response.json({ workbenches: [] }));
        }
        if (url.startsWith("/api/projects")) {
          return Promise.resolve(Response.json({ projects: [] }));
        }
        if (url.startsWith("/api/threads")) {
          return Promise.resolve(Response.json({ threads: [], nextCursor: null }));
        }
        return Promise.resolve(Response.json({}));
      }),
    );
    const socket: ThreadAgentSocket = {
      readyState: WebSocket.OPEN,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      call: vi.fn(async () => undefined),
    };
    const threadChat = {
      useThreadAgent: () => socket as never,
      useThreadChat: (agent: ThreadAgentSocket, initialMessages: ThreadChatApi["messages"]) =>
        ({
          agent,
          messages: initialMessages,
          setMessages: vi.fn(),
          sendMessage: vi.fn(),
          addToolApprovalResponse: vi.fn(),
          status: "ready",
          isStreaming: false,
          error: undefined,
          stop: vi.fn(),
        }) satisfies ThreadChatApi,
    };

    render(
      <ChatApp
        consentWorkspaceId={null}
        user={{ id: "u1", email: "you@example.com" } as never}
        initialProjects={[]}
        initialThreads={[]}
        initialThreadsNextCursor={null}
        onActiveWorkspaceChange={() => {}}
        onSignOut={() => {}}
        voiceEnabled
        backgroundWorkEnabled={false}
        feedbackAdminEnabled={false}
        threadChat={threadChat}
      />,
    );
  }

  it("renders a restricted feedback conversation surface", async () => {
    renderFeedbackRoute();

    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: /message/i }).getAttribute("placeholder")).toBe(
        "Tell Nadi what happened…",
      );
    });
    expect(screen.queryByLabelText(/model/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Thread details" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Thread actions" })).toBeNull();
    expect(screen.queryByText("Workbench")).toBeNull();
    expect(screen.queryByText("Project")).toBeNull();
    expect(screen.queryByRole("button", { name: "Dictate" })).toBeNull();
    expect(screen.queryByText(/tool call/i)).toBeNull();

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(fileInput).not.toBeNull();
    expect(fileInput?.accept).toBe("image/png,image/jpeg,image/webp,image/gif");
  });
});

describe("ChatApp feedback inbox route", () => {
  it("replaces non-admin inbox deep links with home without issuing admin feedback requests", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    window.history.replaceState(null, "", "/admin/feedback/fbr_1");
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      expect(url.startsWith("/api/admin/feedback")).toBe(false);
      if (url === "/api/invites") {
        return Promise.resolve(
          Response.json({ invites: [], quota: { used: 0, limit: 5 }, isSuperuser: false, waitingList: [] }),
        );
      }
      if (url.startsWith("/api/workbenches")) {
        return Promise.resolve(Response.json({ workbenches: [] }));
      }
      if (url.startsWith("/api/projects")) {
        return Promise.resolve(Response.json({ projects: [] }));
      }
      return Promise.resolve(Response.json({ threads: [], nextCursor: null }));
    });
    vi.stubGlobal("fetch", fetchMock);

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
        feedbackAdminEnabled={false}
      />,
    );

    await waitFor(() => expect(window.location.pathname).toBe("/"));
    expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith("/api/admin/feedback"))).toBe(false);
  });
});

describe("ChatApp archive synchronization", () => {
  function renderChatApp(initialThreads: ThreadSummary[], path = "/") {
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    window.history.replaceState(null, "", path);
    return render(<ChatApp consentWorkspaceId={null} user={{ id: "u1", email: "you@example.com" } as never}
      initialProjects={[]} initialThreads={initialThreads} initialThreadsNextCursor={null}
      onActiveWorkspaceChange={() => {}} onSignOut={() => {}} voiceEnabled={false} backgroundWorkEnabled={false} feedbackAdminEnabled={false} />);
  }

  it("keeps a Settings route instead of rewriting it to /", async () => {
    // The thread-resolution effect used to rewrite any route with no thread
    // that wasn't /chats or a panel (Settings included) to "/", wiping the
    // Settings history entry so Back couldn't return to whatever opened it.
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/workbenches"))
        return Promise.resolve(Response.json({ workbenches: [] }));
      if (url.startsWith("/api/projects")) return Promise.resolve(Response.json({ projects: [] }));
      if (url.startsWith("/api/invites"))
        return Promise.resolve(
          Response.json({ invites: [], quota: { used: 0, limit: 5 }, isSuperuser: false, waitingList: [] }),
        );
      return Promise.resolve(Response.json({ threads: [], nextCursor: null }));
    });
    vi.stubGlobal("fetch", fetchMock);
    renderChatApp([], "/settings/general");
    // Wait until the effect has run (threads refreshed) before asserting the
    // route survived — otherwise we'd assert before the buggy rewrite fired.
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith("/api/threads"))).toBe(true),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(window.location.pathname).toBe("/settings/general");
  });

  it("repairs a missed archive when the socket opens", async () => {
    const stale = thread({ threadId: "stale", title: "Stale remote chat" });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/threads/reconcile") {
        expect(JSON.parse(String(init?.body))).toEqual({ threadIds: ["stale"] });
        return Promise.resolve(Response.json({ activeThreadIds: [] }));
      }
      return new Promise<Response>(() => {});
    }));
    renderChatApp([stale]);
    expect(screen.getByText("Stale remote chat")).toBeTruthy();
    live.emitOpen();
    await waitFor(() => expect(screen.queryByText("Stale remote chat")).toBeNull());
  });

  it("does not let a stale refresh resurrect an optimistically archived thread", async () => {
    const archived = thread({ threadId: "archive-me", title: "Archive me" });
    let refreshCount = 0;
    let resolveRefresh!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/threads") && !url.includes("/archive") && !url.includes("/reconcile")) {
        refreshCount += 1;
        if (refreshCount === 1) {
          return Promise.resolve(Response.json({ threads: [archived], nextCursor: null }));
        }
        if (refreshCount > 2) {
          return Promise.resolve(Response.json({ threads: [archived], nextCursor: null }));
        }
        return new Promise<Response>((resolve) => {
          resolveRefresh = resolve;
        });
      }
      if (url === "/api/threads/archive-me/archive") {
        return Promise.resolve(Response.json({
          thread: { ...archived, status: "archived", readOnly: true, archivedAt: 10 },
        }));
      }
      if (url === "/api/threads/reconcile") {
        return Promise.resolve(Response.json({ activeThreadIds: [] }));
      }
      if (url === "/api/invites") {
        return Promise.resolve(Response.json({ invites: [], quota: { used: 0, limit: 5 }, isSuperuser: false, waitingList: [] }));
      }
      if (url.startsWith("/api/workbenches")) {
        return Promise.resolve(Response.json({ workbenches: [] }));
      }
      if (url.startsWith("/api/projects")) {
        return Promise.resolve(Response.json({ projects: [] }));
      }
      return Promise.resolve(Response.json({ threads: [], nextCursor: null }));
    }));

    renderChatApp([archived], "/chats");
    expect(screen.getAllByText("Archive me").length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByLabelText("Actions for Archive me")).toBeTruthy());
    const archiveMenuTrigger = screen.getByLabelText("Actions for Archive me");
    fireEvent.pointerDown(archiveMenuTrigger, { button: 0 });
    fireEvent.pointerUp(archiveMenuTrigger, { button: 0 });
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Archive" })).toBeTruthy());
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(screen.queryByText("Archive me")).toBeNull());

    window.dispatchEvent(new Event("online"));
    await waitFor(() => expect(refreshCount).toBe(2));
    resolveRefresh(Response.json({ threads: [archived], nextCursor: null }));
    await waitFor(() => expect(screen.queryByText("Archive me")).toBeNull());
  });

  it("keeps a confirmed live archive removed when the initiating request rejects", async () => {
    const threadToArchive = thread({ threadId: "race", title: "Archive race" });
    let rejectArchive!: (error: Error) => void;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/threads/race/archive") {
        return new Promise<Response>((_resolve, reject) => {
          rejectArchive = reject;
        });
      }
      if (url.startsWith("/api/threads") && !url.includes("/archive") && !url.includes("/reconcile")) {
        return Promise.resolve(Response.json({ threads: [threadToArchive], nextCursor: null }));
      }
      if (url === "/api/invites") {
        return Promise.resolve(Response.json({ invites: [], quota: { used: 0, limit: 5 }, isSuperuser: false, waitingList: [] }));
      }
      if (url.startsWith("/api/workbenches")) {
        return Promise.resolve(Response.json({ workbenches: [] }));
      }
      if (url.startsWith("/api/projects")) {
        return Promise.resolve(Response.json({ projects: [] }));
      }
      return Promise.resolve(Response.json({ threads: [], nextCursor: null }));
    }));

    renderChatApp([threadToArchive], "/chats");
    await waitFor(() => expect(screen.getByLabelText("Actions for Archive race")).toBeTruthy());
    const archiveMenuTrigger = screen.getByLabelText("Actions for Archive race");
    fireEvent.pointerDown(archiveMenuTrigger, { button: 0 });
    fireEvent.pointerUp(archiveMenuTrigger, { button: 0 });
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Archive" })).toBeTruthy());
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    live.emitMessage({
      type: "thread.archived",
      thread: { ...threadToArchive, archivedAt: 10, readOnly: true, status: "archived" },
    });
    rejectArchive(new TypeError("Failed to fetch"));
    await waitFor(() => expect(screen.queryByText("Archive race")).toBeNull());
  });

  it("keeps a confirmed live delete removed when the initiating request rejects", async () => {
    const threadToDelete = thread({ threadId: "delete-race", title: "Delete race" });
    let rejectDelete!: (error: Error) => void;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/threads/delete-race") {
        return new Promise<Response>((_resolve, reject) => {
          rejectDelete = reject;
        });
      }
      if (url.startsWith("/api/threads") && !url.includes("/reconcile")) {
        return Promise.resolve(Response.json({ threads: [threadToDelete], nextCursor: null }));
      }
      if (url === "/api/invites") {
        return Promise.resolve(Response.json({ invites: [], quota: { used: 0, limit: 5 }, isSuperuser: false, waitingList: [] }));
      }
      if (url.startsWith("/api/workbenches")) {
        return Promise.resolve(Response.json({ workbenches: [] }));
      }
      if (url.startsWith("/api/projects")) {
        return Promise.resolve(Response.json({ projects: [] }));
      }
      return Promise.resolve(Response.json({ threads: [], nextCursor: null }));
    }));

    renderChatApp([threadToDelete], "/chats");
    await waitFor(() => expect(screen.getByLabelText("Actions for Delete race")).toBeTruthy());
    const deleteMenuTrigger = screen.getByLabelText("Actions for Delete race");
    fireEvent.pointerDown(deleteMenuTrigger, { button: 0 });
    fireEvent.pointerUp(deleteMenuTrigger, { button: 0 });
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Delete" })).toBeTruthy());
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    live.emitMessage({ type: "thread.deleted", threadId: threadToDelete.threadId, workspaceId: threadToDelete.workspaceId });
    rejectDelete(new TypeError("Failed to fetch"));
    await waitFor(() => expect(screen.queryByText("Delete race")).toBeNull());
  });

  it("drops a failures_only automaton thread from the rail when its run goes quiet", async () => {
    // The server list query hides a quiet failures_only automaton thread, so a
    // live update that makes it quiet must remove it from the rail too —
    // otherwise it lingers until a hard refresh.
    const run = thread({
      threadId: "auto_run",
      title: "Nightly digest",
      source: "automaton",
      automatonId: "atm_1",
      automatonName: "Digest bot",
      automatonNotifyMode: "failures_only",
      activityStatus: "failed",
      attentionRequiredAt: 5,
    });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/invites") {
        return Promise.resolve(Response.json({ invites: [], quota: { used: 0, limit: 5 }, isSuperuser: false, waitingList: [] }));
      }
      if (url.startsWith("/api/workbenches")) {
        return Promise.resolve(Response.json({ workbenches: [] }));
      }
      if (url.startsWith("/api/projects")) {
        return Promise.resolve(Response.json({ projects: [] }));
      }
      if (url.startsWith("/api/threads") && !url.includes("/reconcile")) {
        return Promise.resolve(Response.json({ threads: [run], nextCursor: null }));
      }
      return Promise.resolve(Response.json({ threads: [], nextCursor: null }));
    }));

    renderChatApp([run], "/chats");
    await waitFor(() => expect(screen.getAllByText("Nightly digest").length).toBeGreaterThan(0));

    live.emitMessage({
      type: "thread.updated",
      thread: { ...run, activityStatus: "idle", attentionRequiredAt: null, updatedAt: run.updatedAt + 1 },
    });
    await waitFor(() => expect(screen.queryAllByText("Nightly digest")).toHaveLength(0));
  });

  it("keeps a quiet failures_only automaton thread out of the rail when it is created live", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/invites") {
        return Promise.resolve(Response.json({ invites: [], quota: { used: 0, limit: 5 }, isSuperuser: false, waitingList: [] }));
      }
      if (url.startsWith("/api/workbenches")) {
        return Promise.resolve(Response.json({ workbenches: [] }));
      }
      if (url.startsWith("/api/projects")) {
        return Promise.resolve(Response.json({ projects: [] }));
      }
      return Promise.resolve(Response.json({ threads: [], nextCursor: null }));
    }));

    renderChatApp([], "/chats");
    live.emitMessage({
      type: "thread.created",
      thread: thread({
        threadId: "auto_new",
        title: "Quiet run",
        source: "automaton",
        automatonId: "atm_1",
        automatonName: "Quiet bot",
        automatonNotifyMode: "failures_only",
        activityStatus: "running",
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryAllByText("Quiet run")).toHaveLength(0);
  });

});

describe("RailContent dismissal", () => {
  const plain = thread({ threadId: "plain", title: "Plain chat", updatedAt: 100 });
  const dismissed = thread({
    threadId: "dismissed", title: "Dismissed chat", updatedAt: 100, recentDismissedAt: 150,
  });

  it("hides a dismissed thread from the recent list", () => {
    render(<RailContent {...baseProps({ threads: [plain, dismissed] })} />);
    expect(screen.queryByText("Dismissed chat")).toBeNull();
    expect(screen.getByText("Plain chat")).toBeTruthy();
  });

  it("shows a dismissed thread among search results", () => {
    render(<RailContent {...baseProps({ threads: [plain, dismissed] })} />);
    fireEvent.change(screen.getByLabelText("Search chats"), { target: { value: "Dismissed" } });
    expect(screen.getByText("Dismissed chat")).toBeTruthy();
  });

  it("keeps showing a dismissed thread while it is the active one", () => {
    render(<RailContent {...baseProps({ threads: [plain, dismissed], activeThreadId: "dismissed" })} />);
    expect(screen.getByText("Dismissed chat")).toBeTruthy();
  });

  it("brings the thread back once activity outruns the dismissal", () => {
    const returned = thread({
      threadId: "dismissed", title: "Dismissed chat", updatedAt: 200, recentDismissedAt: 150,
    });
    render(<RailContent {...baseProps({ threads: [plain, returned] })} />);
    expect(screen.getByText("Dismissed chat")).toBeTruthy();
  });
});

describe("RailContent row menu", () => {
  function mockLayout({ wide, finePointer }: { wide: boolean; finePointer: boolean }) {
    window.matchMedia = ((query: string) =>
      ({
        matches:
          (wide && query === WIDE_LAYOUT_QUERY) ||
          (finePointer && query === FINE_POINTER_QUERY),
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList) as typeof window.matchMedia;
  }

  function wideLayout() {
    mockLayout({ wide: true, finePointer: true });
  }

  function narrowDesktop() {
    mockLayout({ wide: false, finePointer: true });
  }

  // The ⋮ trigger renders for pointer users; touch-primary layouts reach the
  // same menu by long press, where the trigger is an aria-hidden anchor.

  async function openMenu(title: string) {
    const trigger = screen.getByLabelText(`Actions for ${title}`);
    fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.pointerUp(trigger, { button: 0 });
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Dismiss" })).toBeTruthy());
  }

  it("offers Dismiss and calls back with the thread", async () => {
    wideLayout();
    const onDismissThread = vi.fn();
    const target = thread({ threadId: "t1", title: "Dismiss me" });
    render(<RailContent {...baseProps({ threads: [target], onDismissThread })} />);

    await openMenu("Dismiss me");
    fireEvent.click(screen.getByRole("menuitem", { name: "Dismiss" }));
    expect(onDismissThread).toHaveBeenCalledWith(expect.objectContaining({ threadId: "t1" }));
  });

  it("offers Mark as read only while the thread carries an unread outcome", async () => {
    wideLayout();
    const onMarkThreadRead = vi.fn();
    const unread = thread({ threadId: "t1", title: "Unread one", unreadOutcome: "completed" });
    const read = thread({ threadId: "t2", title: "Read one", unreadOutcome: null });
    render(<RailContent {...baseProps({ threads: [unread, read], onMarkThreadRead })} />);

    await openMenu("Read one");
    expect(screen.queryByRole("menuitem", { name: "Mark as read" })).toBeNull();
    fireEvent.keyDown(document.body, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("menuitem", { name: "Dismiss" })).toBeNull());
    await openMenu("Unread one");
    fireEvent.click(screen.getByRole("menuitem", { name: "Mark as read" }));
    expect(onMarkThreadRead).toHaveBeenCalledWith("t1");
  });

  it("no longer offers archiving — All chats owns that", async () => {
    wideLayout();
    const target = thread({ threadId: "t1", title: "Keep me" });
    render(<RailContent {...baseProps({ threads: [target] })} />);

    await openMenu("Keep me");
    expect(screen.queryByRole("menuitem", { name: /archive/i })).toBeNull();
  });

  it("opens the row menu on right-click", async () => {
    wideLayout();
    const target = thread({ threadId: "t1", title: "Right click me" });
    render(<RailContent {...baseProps({ threads: [target] })} />);

    fireEvent.contextMenu(screen.getByText("Right click me"));
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Dismiss" })).toBeTruthy());
  });

  it("shows the ⋮ trigger on a narrow desktop window", async () => {
    narrowDesktop();
    const target = thread({ threadId: "t1", title: "Narrow desktop" });
    render(<RailContent {...baseProps({ threads: [target] })} />);

    expect(screen.getByLabelText("Actions for Narrow desktop")).toBeTruthy();
    await openMenu("Narrow desktop");
  });
});

describe("a thread deleted while it is open", () => {
  function thread(over: Partial<ThreadSummary> & { threadId: string }): ThreadSummary {
    return {
      kind: "regular",
      workspaceId: "ws_1",
      agentId: "agt_1",
      provider: "openai",
      model: "gpt-5.4-mini",
      modelInputModalities: ["text"],
      reasoningEffort: "medium",
      modelSupportsReasoning: null,
      runtime: "think",
      title: "Open thread",
      source: "manual",
      lastMessagePreview: "",
      archivedAt: null,
      readOnly: false,
      status: "active",
      projectId: null,
      projectName: null,
      workbenchId: null,
      workbenchName: null,
      ...over,
    } as ThreadSummary;
  }

  function renderOpenThread(target: ThreadSummary) {
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    window.history.replaceState(null, "", `/threads/${target.threadId}`);
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `/think-agents/think-thread-agent/${target.threadId}/get-messages`) {
          return Promise.resolve(Response.json({ messages: [] }));
        }
        if (url === "/api/invites") {
          return Promise.resolve(
            Response.json({ invites: [], quota: { used: 0, limit: 5 }, isSuperuser: false, waitingList: [] }),
          );
        }
        if (url.startsWith("/api/workbenches")) return Promise.resolve(Response.json({ workbenches: [] }));
        if (url.startsWith("/api/projects")) return Promise.resolve(Response.json({ projects: [] }));
        if (url.startsWith("/api/threads")) {
          return Promise.resolve(Response.json({ threads: [target], nextCursor: null }));
        }
        return Promise.resolve(Response.json({}));
      }),
    );
    const socket: ThreadAgentSocket = {
      readyState: WebSocket.OPEN,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      call: vi.fn(async () => undefined),
    };
    const threadChat = {
      useThreadAgent: () => socket as never,
      useThreadChat: (agent: ThreadAgentSocket, initialMessages: ThreadChatApi["messages"]) =>
        ({
          agent,
          messages: initialMessages,
          setMessages: vi.fn(),
          sendMessage: vi.fn(),
          addToolApprovalResponse: vi.fn(),
          status: "ready",
          isStreaming: false,
          error: undefined,
          stop: vi.fn(),
        }) satisfies ThreadChatApi,
    };
    render(
      <ChatApp
        consentWorkspaceId={null}
        user={{ id: "u1", email: "you@example.com" } as never}
        initialProjects={[]}
        initialThreads={[target]}
        initialThreadsNextCursor={null}
        onActiveWorkspaceChange={() => {}}
        onSignOut={() => {}}
        voiceEnabled={false}
        backgroundWorkEnabled={false}
        feedbackAdminEnabled={false}
        threadChat={threadChat}
      />,
    );
  }

  it("leaves the route instead of holding a socket open against a thread that is gone", async () => {
    // Deleting from another tab/device broadcasts thread.deleted. Dropping it
    // from the rail is not enough while it is the thread on screen: the route
    // still points at it, so ThreadChat keeps dialing a thread the server no
    // longer has and the composer sits on "Connecting…" forever.
    const target = thread({ threadId: "thr_open", title: "Open thread" });
    renderOpenThread(target);

    await waitFor(() => expect(window.location.pathname).toBe("/threads/thr_open"));

    live.emitMessage({ type: "thread.deleted", threadId: "thr_open", workspaceId: "ws_1" });

    await waitFor(() => expect(window.location.pathname).toBe("/chats"));
  });

  it("stays put when the deleted thread is a different one", async () => {
    // The guard is "is this what the user is looking at", so an unrelated
    // deletion must not navigate anyone anywhere.
    const target = thread({ threadId: "thr_open", title: "Open thread" });
    renderOpenThread(target);

    await waitFor(() => expect(window.location.pathname).toBe("/threads/thr_open"));

    live.emitMessage({ type: "thread.deleted", threadId: "thr_other", workspaceId: "ws_1" });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(window.location.pathname).toBe("/threads/thr_open");
  });
});

describe("ChatApp rail toggle badge", () => {
  function renderAtHome(initialThreads: ThreadSummary[]) {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    window.history.replaceState(null, "", "/");
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/invites") {
          return Promise.resolve(
            Response.json({
              invites: [],
              quota: { used: 0, limit: 5 },
              isSuperuser: false,
              waitingList: [],
            }),
          );
        }
        if (url.startsWith("/api/workbenches")) {
          return Promise.resolve(Response.json({ workbenches: [] }));
        }
        if (url.startsWith("/api/projects")) {
          return Promise.resolve(Response.json({ projects: [] }));
        }
        if (url.startsWith("/api/threads")) {
          return Promise.resolve(Response.json({ threads: initialThreads, nextCursor: null }));
        }
        return Promise.resolve(Response.json({}));
      }),
    );
    return render(
      <ChatApp
        consentWorkspaceId={null}
        user={{ id: "u1", email: "you@example.com" } as never}
        initialProjects={[]}
        initialThreads={initialThreads}
        initialThreadsNextCursor={null}
        onActiveWorkspaceChange={() => {}}
        onSignOut={() => {}}
        voiceEnabled={false}
        backgroundWorkEnabled={false}
        feedbackAdminEnabled={false}
      />,
    );
  }

  it("does not badge unread that only lives past the sidebar cap", async () => {
    const recent = Array.from({ length: SIDEBAR_RECENT_THREAD_LIMIT }, (_, i) =>
      thread({ threadId: `recent_${i}`, title: `Recent ${i}`, updatedAt: 200 - i }),
    );
    const overflow = thread({
      threadId: "overflow",
      title: "All-chats only unread",
      updatedAt: 1,
      unreadOutcome: "completed",
    });
    renderAtHome([...recent, overflow]);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Show chats/ })).toBeTruthy(),
    );
    expect(screen.getByRole("button", { name: "Show chats" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show chats, unread chats" })).toBeNull();
  });

  it("badges unread that appears in the sidebar", async () => {
    renderAtHome([
      thread({
        threadId: "recent_0",
        title: "Recent unread",
        updatedAt: 200,
        unreadOutcome: "completed",
      }),
    ]);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Show chats, unread chats" })).toBeTruthy(),
    );
  });

  it("does not badge a dismissed unread thread that only All chats still shows", async () => {
    renderAtHome([
      thread({
        threadId: "hidden",
        title: "Dismissed unread",
        updatedAt: 100,
        recentDismissedAt: 150,
        unreadOutcome: "completed",
      }),
    ]);

    await waitFor(() => expect(screen.getByRole("button", { name: "Show chats" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Show chats, unread chats" })).toBeNull();
  });
});

describe("ChatApp dismiss of the open thread", () => {
  function pointerLayout() {
    window.matchMedia = ((query: string) =>
      ({
        matches: query === WIDE_LAYOUT_QUERY || query === FINE_POINTER_QUERY,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList) as typeof window.matchMedia;
  }

  function renderOpenThreads(threads: ThreadSummary[], openId: string) {
    pointerLayout();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    window.history.replaceState(null, "", `/threads/${openId}`);
    const open = threads.find((item) => item.threadId === openId)!;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === `/think-agents/think-thread-agent/${openId}/get-messages`) {
          return Promise.resolve(Response.json({ messages: [] }));
        }
        if (url === "/api/invites") {
          return Promise.resolve(
            Response.json({
              invites: [],
              quota: { used: 0, limit: 5 },
              isSuperuser: false,
              waitingList: [],
            }),
          );
        }
        if (url.startsWith("/api/workbenches")) {
          return Promise.resolve(Response.json({ workbenches: [] }));
        }
        if (url.startsWith("/api/projects")) {
          return Promise.resolve(Response.json({ projects: [] }));
        }
        if (url.endsWith("/dismiss-recent") && method === "POST") {
          const threadId = url.split("/").at(-2)!;
          const target = threads.find((item) => item.threadId === threadId) ?? open;
          return Promise.resolve(
            Response.json({ thread: { ...target, recentDismissedAt: Date.now() } }),
          );
        }
        if (url.startsWith("/api/threads")) {
          return Promise.resolve(Response.json({ threads, nextCursor: null }));
        }
        return Promise.resolve(Response.json({}));
      }),
    );
    const socket: ThreadAgentSocket = {
      readyState: WebSocket.OPEN,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      call: vi.fn(async () => undefined),
    };
    const threadChat = {
      useThreadAgent: () => socket as never,
      useThreadChat: (agent: ThreadAgentSocket, initialMessages: ThreadChatApi["messages"]) =>
        ({
          agent,
          messages: initialMessages,
          setMessages: vi.fn(),
          sendMessage: vi.fn(),
          addToolApprovalResponse: vi.fn(),
          status: "ready",
          isStreaming: false,
          error: undefined,
          stop: vi.fn(),
        }) satisfies ThreadChatApi,
    };
    return render(
      <ChatApp
        consentWorkspaceId={null}
        user={{ id: "u1", email: "you@example.com" } as never}
        initialProjects={[]}
        initialThreads={threads}
        initialThreadsNextCursor={null}
        onActiveWorkspaceChange={() => {}}
        onSignOut={() => {}}
        voiceEnabled={false}
        backgroundWorkEnabled={false}
        feedbackAdminEnabled={false}
        threadChat={threadChat}
      />,
    );
  }

  async function openRowMenu(title: string) {
    await waitFor(() =>
      expect(screen.getAllByLabelText(`Actions for ${title}`).length).toBeGreaterThan(0),
    );
    const trigger = screen.getAllByLabelText(`Actions for ${title}`)[0]!;
    fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.pointerUp(trigger, { button: 0 });
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Dismiss" })).toBeTruthy());
  }

  it("lands on a new chat when the dismissed thread is the one on screen", async () => {
    const target = thread({ threadId: "thr_open", title: "Open thread", updatedAt: 200 });
    renderOpenThreads([target], "thr_open");

    await waitFor(() => expect(window.location.pathname).toBe("/threads/thr_open"));
    await openRowMenu("Open thread");
    fireEvent.click(screen.getByRole("menuitem", { name: "Dismiss" }));

    await waitFor(() => expect(window.location.pathname).toBe("/"));
  });

  it("stays on the open thread when a different one is dismissed", async () => {
    const open = thread({ threadId: "thr_open", title: "Open thread", updatedAt: 200 });
    const other = thread({ threadId: "thr_other", title: "Other thread", updatedAt: 150 });
    renderOpenThreads([open, other], "thr_open");

    await waitFor(() => expect(window.location.pathname).toBe("/threads/thr_open"));
    await openRowMenu("Other thread");
    fireEvent.click(screen.getByRole("menuitem", { name: "Dismiss" }));

    await waitFor(() => expect(screen.queryByRole("menuitem", { name: "Dismiss" })).toBeNull());
    expect(window.location.pathname).toBe("/threads/thr_open");
  });
});
