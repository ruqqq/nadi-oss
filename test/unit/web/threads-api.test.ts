import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupServer } from "../../../web/node_modules/msw/node";
import type { UIMessage } from "ai";
import {
  FeedbackRateLimitError,
  createManualFeedbackDraft,
  getFeedbackReport,
  getOrCreateFeedbackThread,
  listFeedbackReports,
  markFeedbackReportSeen,
  sendFeedbackMessage,
  submitFeedbackDraft,
  type FeedbackDiagnostics,
  type FeedbackReportFields,
} from "../../../web/src/feedback-api";
import { restHandlers } from "../../../web/src/mocks/rest";
import { getStore, resetStore, seedStore } from "../../../web/src/mocks/store";
import {
  archiveThread,
  compactThread,
  createThread,
  deleteThread,
  getThreadCompactionStatus,
  getThread,
  getThreadOrNull,
  listThreads,
  markThreadSeen,
  moveThreadToProject,
  renameThread,
  reconcileThreads,
  sendThreadMessage,
  updateThreadReasoningEffort,
  type ThreadSummary,
} from "../../../web/src/threads-api";

const server = setupServer(...(restHandlers as unknown as Parameters<typeof setupServer>));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  resetStore();
});
afterAll(() => server.close());

const thread: ThreadSummary = {
  threadId: "thr_1",
  kind: "regular",
  workspaceId: "workspace-1",
  agentId: "agent-1",
  provider: "openai-oauth",
  model: "gpt-5.5",
  modelInputModalities: ["text", "image", "file"],
  showReasoning: true,
  reasoningEffort: "medium",
  modelSupportsReasoning: true,
  runtime: "legacy",
  title: "New thread",
  source: "manual" as const,
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
  lastContextTokens: null,
  lastContextWindow: null,
  lastCompactAfterTokens: null,
  createdAt: 1,
  updatedAt: 2,
};

const feedbackFields: FeedbackReportFields = {
  category: "bug",
  title: "Composer freezes after screenshot upload",
  narrative: "After attaching a screenshot, the feedback composer stopped accepting text.",
  reproductionSteps: ["Open Send feedback", "Attach a screenshot", "Try to keep typing"],
  expectedBehavior: "The composer stays editable after uploads finish.",
  actualBehavior: "The textarea is stuck until the page is reloaded.",
  frequency: "Every time with large PNGs",
  impact: "Blocks users from completing feedback reports.",
};

const feedbackDiagnostics: FeedbackDiagnostics = {
  schemaVersion: 1,
  route: "/feedback",
  build: "mock-build",
  browser: "Chrome 130",
  os: "macOS",
  viewport: { width: 1280, height: 800 },
  theme: "light",
  online: true,
};

function feedbackMessage(text = "The screenshot upload locked the composer."): UIMessage {
  return {
    id: "msg_feedback_user",
    role: "user",
    parts: [{ type: "text", text }],
  } as unknown as UIMessage;
}

const mswFetch: typeof fetch = (input, init) => {
  const url = typeof input === "string" ? new URL(input, "http://localhost").toString() : input;
  return fetch(url, init);
};

describe("thread api helpers", () => {
  beforeEach(() => seedStore("default"));

  it("reconciles a batch of locally held thread IDs", async () => {
    const fetch = vi.fn(async () => Response.json({ activeThreadIds: ["a"] }));
    await expect(reconcileThreads(["a", "b"], fetch)).resolves.toEqual(["a"]);
    expect(fetch).toHaveBeenCalledWith("/api/threads/reconcile", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadIds: ["a", "b"] }),
    });
  });

  it("lists authenticated threads", async () => {
    const fetch = vi.fn(async () => Response.json({ threads: [thread] }));

    await expect(listThreads(fetch)).resolves.toEqual({ threads: [thread], nextCursor: null });

    expect(fetch).toHaveBeenCalledWith("/api/threads", {
      credentials: "include",
    });
  });

  it("parses thread runtime from the API", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        threads: [
          {
            ...thread,
            threadId: "thr_think",
            runtime: "think",
          },
        ],
      }),
    );

    await expect(listThreads(fetch)).resolves.toEqual({
      threads: [expect.objectContaining({ threadId: "thr_think", runtime: "think" })],
      nextCursor: null,
    });
  });

  it("sends no limit/cursor/q params when options are omitted", async () => {
    const urls: string[] = [];
    const fetch = (url: string) => {
      urls.push(url);
      return Promise.resolve(Response.json({ threads: [thread] }));
    };

    await listThreads(fetch as unknown as typeof globalThis.fetch);

    const url = urls[0];
    expect(url).toBe("/api/threads");
    expect(url).not.toContain("limit");
    expect(url).not.toContain("cursor");
    expect(url).not.toContain("q=");
  });

  it("sends limit, cursor, and q as query params when provided", async () => {
    const urls: string[] = [];
    const fetch = (url: string) => {
      urls.push(url);
      return Promise.resolve(Response.json({ threads: [thread] }));
    };

    await listThreads(fetch as unknown as typeof globalThis.fetch, "active", "all", {
      limit: 30,
      cursor: "abc123",
      q: "hello",
    });

    const url = urls[0];
    expect(url).toContain("limit=30");
    expect(url).toContain("cursor=abc123");
    expect(url).toContain("q=hello");
  });

  it("URL-encodes the q param", async () => {
    const urls: string[] = [];
    const fetch = (url: string) => {
      urls.push(url);
      return Promise.resolve(Response.json({ threads: [thread] }));
    };

    await listThreads(fetch as unknown as typeof globalThis.fetch, "active", "all", {
      q: "50% & more",
    });

    const url = urls[0];
    expect(url).toContain(`q=${encodeURIComponent("50% & more")}`);
    expect(url).not.toContain("50% & more");
  });

  it("returns nextCursor from the server when present", async () => {
    const fetch = vi.fn(async () => Response.json({ threads: [thread], nextCursor: "next-page" }));

    await expect(listThreads(fetch)).resolves.toEqual({
      threads: [thread],
      nextCursor: "next-page",
    });
  });

  it("opens an encoded registered thread", async () => {
    const fetch = vi.fn(async () => Response.json({ thread }));

    await expect(getThread("thr_1/with slash", fetch)).resolves.toEqual(thread);

    expect(fetch).toHaveBeenCalledWith("/api/threads/thr_1%2Fwith%20slash", {
      credentials: "include",
    });
  });

  it("creates authenticated threads server-side", async () => {
    const fetch = vi.fn(async () => Response.json({ thread }, { status: 201 }));

    await expect(createThread(undefined, fetch)).resolves.toEqual(thread);

    expect(fetch).toHaveBeenCalledWith("/api/threads", {
      method: "POST",
      credentials: "include",
    });
  });

  it("creates authenticated threads with a model snapshot", async () => {
    const fetch = vi.fn(async () => Response.json({ thread }, { status: 201 }));

    await expect(
      createThread(
        {
          provider: "openai-oauth",
          model: "gpt-5.5",
          modelInputModalities: ["text", "image"],
          showReasoning: false,
        },
        fetch,
      ),
    ).resolves.toEqual(thread);

    expect(fetch).toHaveBeenCalledWith("/api/threads", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openai-oauth",
        model: "gpt-5.5",
        modelInputModalities: ["text", "image"],
        showReasoning: false,
      }),
    });
  });

  it("creates authenticated threads with a project assignment", async () => {
    const fetch = vi.fn(async () => Response.json({ thread }, { status: 201 }));

    await expect(createThread({ projectId: "project-1" }, fetch)).resolves.toEqual(thread);

    expect(fetch).toHaveBeenCalledWith("/api/threads", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "project-1" }),
    });
  });

  it("lists archived threads with a status filter", async () => {
    const fetch = vi.fn(async () => Response.json({ threads: [thread] }));

    await expect(listThreads(fetch, "archived")).resolves.toEqual({
      threads: [thread],
      nextCursor: null,
    });

    expect(fetch).toHaveBeenCalledWith("/api/threads?status=archived", {
      credentials: "include",
    });
  });

  it("lists unassigned threads with the project helper query", async () => {
    const fetch = vi.fn(async () => Response.json({ threads: [thread] }));

    await expect(listThreads(fetch, "active", "unassigned")).resolves.toEqual({
      threads: [thread],
      nextCursor: null,
    });

    expect(fetch).toHaveBeenCalledWith("/api/threads?project=unassigned", {
      credentials: "include",
    });
  });

  it("lists project threads with an encoded projectId query", async () => {
    const fetch = vi.fn(async () => Response.json({ threads: [thread] }));

    await expect(listThreads(fetch, "active", "proj/a b")).resolves.toEqual({
      threads: [thread],
      nextCursor: null,
    });

    expect(fetch).toHaveBeenCalledWith("/api/threads?projectId=proj%2Fa%20b", {
      credentials: "include",
    });
  });

  it("archives a thread with an encoded id", async () => {
    const archived = { ...thread, archivedAt: 123, readOnly: true, status: "archived" as const };
    const fetch = vi.fn(async () => Response.json({ thread: archived }));

    await expect(archiveThread("thr_1/with slash", fetch)).resolves.toEqual(archived);

    expect(fetch).toHaveBeenCalledWith("/api/threads/thr_1%2Fwith%20slash/archive", {
      method: "POST",
      credentials: "include",
    });
  });

  it("deletes a thread with an encoded id", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));

    await expect(deleteThread("thr_1/with slash", fetch)).resolves.toBeUndefined();

    expect(fetch).toHaveBeenCalledWith("/api/threads/thr_1%2Fwith%20slash", {
      method: "DELETE",
      credentials: "include",
    });
  });

  it("renames a thread with an encoded id and json body", async () => {
    const renamed = { ...thread, title: "Renamed" };
    const fetch = vi.fn(async () => Response.json({ thread: renamed }));

    await expect(renameThread("thr_1/x", "Renamed", fetch)).resolves.toEqual(renamed);

    expect(fetch).toHaveBeenCalledWith("/api/threads/thr_1%2Fx", {
      method: "PATCH",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Renamed" }),
    });
  });

  it("updates a thread's reasoning effort with an encoded id and json body", async () => {
    const updated = { ...thread, reasoningEffort: "high" as const };
    const fetch = vi.fn(async () => Response.json({ thread: updated }));

    await expect(updateThreadReasoningEffort("thr_1/x", "high", fetch)).resolves.toEqual(updated);

    expect(fetch).toHaveBeenCalledWith("/api/threads/thr_1%2Fx", {
      method: "PATCH",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reasoningEffort: "high" }),
    });
  });

  it("moves a thread to a project with an encoded id and json body", async () => {
    const moved = { ...thread, projectId: "proj 1", projectName: "Proj 1" };
    const fetch = vi.fn(async () => Response.json({ thread: moved }));

    await expect(moveThreadToProject("thr_1/x", "proj 1", fetch)).resolves.toEqual(moved);

    expect(fetch).toHaveBeenCalledWith("/api/threads/thr_1%2Fx", {
      method: "PATCH",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: "proj 1" }),
    });
  });

  it("compacts a thread with an encoded id", async () => {
    const result = { compacted: true, message: "Thread compacted." };
    const fetch = vi.fn(async () => Response.json(result));

    await expect(compactThread("thr_1/x", fetch)).resolves.toEqual(result);

    expect(fetch).toHaveBeenCalledWith("/api/threads/thr_1%2Fx/compact", {
      method: "POST",
      credentials: "include",
    });
  });

  it("gets compaction status for an encoded thread id", async () => {
    const status = { phase: "compacting" as const };
    const fetch = vi.fn(async () => Response.json(status));

    await expect(getThreadCompactionStatus("thr_1/x", fetch)).resolves.toEqual(status);

    expect(fetch).toHaveBeenCalledWith("/api/threads/thr_1%2Fx/compact/status", {
      credentials: "include",
    });
  });

  it("marks a thread seen with an encoded id", async () => {
    const seen = {
      ...thread,
      unreadOutcome: null,
      unreadOutcomeAt: null,
      lastSeenAt: 123,
    };
    const fetch = vi.fn(async () => Response.json({ thread: seen }));

    await expect(markThreadSeen("thr_1/x", fetch)).resolves.toEqual(seen);

    expect(fetch).toHaveBeenCalledWith("/api/threads/thr_1%2Fx/seen", {
      method: "POST",
      credentials: "include",
    });
  });

  it("marks a thread seen", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ thread: { ...thread, threadId: "t1", unreadOutcome: null } }),
    );

    await markThreadSeen("t1", fetch);

    expect(fetch).toHaveBeenCalledWith(
      "/api/threads/t1/seen",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("throws human-readable errors for non-ok responses", async () => {
    const NOT_FOUND = "That item couldn't be found — it may have already been removed.";
    await expect(
      listThreads(vi.fn(async () => new Response("", { status: 401 }))),
    ).rejects.toThrow("Your session expired. Refresh the page and sign in again.");
    await expect(
      getThread("missing", vi.fn(async () => new Response("", { status: 404 }))),
    ).rejects.toThrow(NOT_FOUND);
    await expect(
      createThread(undefined, vi.fn(async () => new Response("", { status: 500 }))),
    ).rejects.toThrow("Something went wrong while trying to start a new chat. Please try again.");
    await expect(
      archiveThread("thr_1", vi.fn(async () => new Response("", { status: 404 }))),
    ).rejects.toThrow(NOT_FOUND);
    await expect(
      deleteThread("thr_1", vi.fn(async () => new Response("", { status: 404 }))),
    ).rejects.toThrow(NOT_FOUND);
    await expect(
      getThreadCompactionStatus("thr_1", vi.fn(async () => new Response("", { status: 404 }))),
    ).rejects.toThrow(NOT_FOUND);
  });
});

describe("feedback mock api contract", () => {
  beforeEach(() => seedStore("feedback"));

  it("creates one reusable feedback thread and accepts feedback messages", async () => {
    const first = await getOrCreateFeedbackThread(mswFetch);
    const second = await getOrCreateFeedbackThread(mswFetch);

    expect(first.threadId).toBe("thr_feedback_mock");
    expect(second.threadId).toBe(first.threadId);
    expect(first.kind).toBe("feedback");

    await expect(
      sendFeedbackMessage({ threadId: first.threadId, message: feedbackMessage() }, mswFetch),
    ).resolves.toBeUndefined();
  });

  it("persists submitted feedback messages into the mock thread history", async () => {
    const thread = await getOrCreateFeedbackThread(mswFetch);
    await sendFeedbackMessage(
      {
        threadId: thread.threadId,
        message: feedbackMessage("Actual submitted text from the user."),
      },
      mswFetch,
    );

    const res = await mswFetch(
      `http://localhost/think-agents/think-thread-agent/${thread.threadId}/get-messages`,
    );
    const body = (await res.json()) as { messages: Array<{ parts: Array<{ text?: string }> }> };

    expect(body.messages.some((message) => message.parts.some((part) => part.text === "Actual submitted text from the user."))).toBe(true);
  });

  it("carries uploaded feedback screenshot attachment IDs into generated drafts", async () => {
    const thread = await getOrCreateFeedbackThread(mswFetch);
    getStore().feedback.drafts = [];
    await sendFeedbackMessage(
      {
        threadId: thread.threadId,
        message: {
          id: "msg_feedback_user",
          role: "user",
          parts: [
            { type: "text", text: "The screenshot upload locked the composer." },
            {
              type: "file",
              mediaType: "image/png",
              filename: "locked.png",
              url: "/api/attachments/att_uploaded",
              attachmentId: "att_uploaded",
            },
          ],
        } as unknown as UIMessage,
      },
      mswFetch,
    );

    expect(getStore().feedback.drafts[0]?.attachmentIds).toEqual(["att_uploaded"]);
  });

  it("creates manual drafts, submits them idempotently, and exposes the report to admins", async () => {
    seedStore("feedback-admin");
    const draft = await createManualFeedbackDraft(
      {
        threadId: "thr_feedback_mock",
        interviewId: "interview_manual",
        fromMessageId: "msg_feedback_user",
        fields: feedbackFields,
        attachmentIds: ["att_feedback_screenshot"],
      },
      mswFetch,
    );

    expect(draft.fields).toEqual(feedbackFields);
    expect(draft.attachmentIds).toEqual(["att_feedback_screenshot"]);

    const firstSubmit = await submitFeedbackDraft(
      {
        draftId: draft.id,
        idempotencyKey: "idem-feedback-1",
        diagnostics: feedbackDiagnostics,
      },
      mswFetch,
    );
    const secondSubmit = await submitFeedbackDraft(
      {
        draftId: draft.id,
        idempotencyKey: "idem-feedback-1",
        diagnostics: feedbackDiagnostics,
      },
      mswFetch,
    );

    expect(firstSubmit.created).toBe(true);
    expect(secondSubmit.created).toBe(false);
    expect(secondSubmit.report).toEqual(firstSubmit.report);
    expect(getStore().feedback.drafts.some((candidate) => candidate.id === draft.id)).toBe(false);

    const page = await listFeedbackReports({ limit: 25 }, mswFetch);
    expect(page.reports).toEqual(
      expect.arrayContaining([
      expect.objectContaining({
        id: firstSubmit.report.id,
        title: feedbackFields.title,
        category: "bug",
        attachmentCount: 1,
        seen: false,
      }),
      ]),
    );

    const detail = await getFeedbackReport(firstSubmit.report.id, mswFetch);
    expect(detail.report.fields).toEqual(feedbackFields);
    expect(detail.report.diagnostics).toEqual(feedbackDiagnostics);
    expect(detail.attachments).toEqual([
      {
        id: "att_feedback_screenshot",
        url: `/api/admin/feedback/${firstSubmit.report.id}/attachments/att_feedback_screenshot`,
      },
    ]);
    await expect(mswFetch(`http://localhost${detail.attachments[0]?.url ?? ""}`)).resolves.toMatchObject({
      ok: true,
    });
    expect(detail.transcript).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "msg_feedback_user" })]),
    );
  });

  it("paginates admin reports, returns details, and mutates seen markers", async () => {
    seedStore("feedback-admin");

    const firstPage = await listFeedbackReports({ limit: 2 }, mswFetch);
    expect(firstPage.reports).toHaveLength(2);
    expect(firstPage.nextCursor).toBe("2");
    expect(firstPage.reports.map((report) => report.category)).toEqual(["bug", "feature"]);
    expect(firstPage.reports[0]?.seen).toBe(false);

    const secondPage = await listFeedbackReports(
      { limit: 2, cursor: firstPage.nextCursor ?? "" },
      mswFetch,
    );
    expect(secondPage.reports).toHaveLength(1);
    expect(secondPage.nextCursor).toBeNull();
    expect(secondPage.reports[0]?.category).toBe("general");

    const selectedId = firstPage.reports[0]?.id ?? "";
    const detail = await getFeedbackReport(selectedId, mswFetch);
    expect(detail.report.id).toBe(selectedId);
    expect(detail.attachments.length).toBeGreaterThan(0);
    expect(detail.transcript.length).toBeGreaterThan(0);

    await markFeedbackReportSeen(selectedId, mswFetch);
    const refreshed = await listFeedbackReports({ limit: 2 }, mswFetch);
    expect(refreshed.reports[0]).toEqual(expect.objectContaining({ id: selectedId, seen: true }));
  });

  it("returns the deterministic feedback rate-limit shape", async () => {
    seedStore("feedback-rate-limited");
    const thread = await getOrCreateFeedbackThread(mswFetch);

    await expect(
      sendFeedbackMessage(
        { threadId: thread.threadId, message: feedbackMessage("Still broken") },
        mswFetch,
      ),
    ).rejects.toMatchObject({
      name: "FeedbackRateLimitError",
      retryAfterSeconds: 900,
    } satisfies Partial<FeedbackRateLimitError>);
  });
});

describe("sendThreadMessage", () => {
  it("posts the message to the thread's messages endpoint", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (url: string, init?: RequestInit) => {
      if (init === undefined) {
        calls.push({ url });
      } else {
        calls.push({ url, init });
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 202 }));
    };

    const message = { id: "m1", role: "user" as const, parts: [{ type: "text" as const, text: "hi" }] };
    await sendThreadMessage("thr_1", message, fetchImpl as unknown as typeof fetch);

    expect(calls[0]?.url).toBe("/api/threads/thr_1/messages");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ message });
  });

  it("throws a human-readable error when the server rejects it", async () => {
    const fetchImpl = () =>
      Promise.resolve(new Response("Message is empty or malformed", { status: 400 }));

    await expect(
      sendThreadMessage(
        "thr_1",
        { id: "m1", role: "user", parts: [{ type: "text", text: "" }] },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/empty or malformed/i);
  });
});

describe("archiveThread 409 handling", () => {
  // The server distinguishes the two 409s ("still responding" vs "no messages to
  // archive; delete it instead"). The client used to hardcode the first message for
  // ANY 409, so a user archiving an empty thread was told it was still responding.
  it("surfaces the server's reason for a 409 instead of assuming 'still responding'", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("This thread has no messages to archive; delete it instead", {
          status: 409,
        }),
    );
    await expect(archiveThread("thr_1", fetchImpl)).rejects.toThrow(
      "This thread has no messages to archive; delete it instead",
    );
  });
});

describe("getThreadOrNull", () => {
  it("returns the thread on 200", async () => {
    const fetch = vi.fn(async () => Response.json({ thread }));

    await expect(getThreadOrNull("thr_1", fetch)).resolves.toEqual(thread);

    expect(fetch).toHaveBeenCalledWith("/api/threads/thr_1", {
      credentials: "include",
    });
  });

  it("returns null on 404", async () => {
    const fetch = vi.fn(async () => new Response("", { status: 404 }));

    await expect(getThreadOrNull("missing", fetch)).resolves.toBeNull();
  });

  it("throws on 500", async () => {
    const fetch = vi.fn(async () => new Response("", { status: 500 }));

    await expect(getThreadOrNull("thr_1", fetch)).rejects.toThrow(
      "Something went wrong while trying to open this chat",
    );
  });

  it("encodes the thread id", async () => {
    const fetch = vi.fn(async () => Response.json({ thread }));

    await expect(getThreadOrNull("thr_1/with slash", fetch)).resolves.toEqual(thread);

    expect(fetch).toHaveBeenCalledWith("/api/threads/thr_1%2Fwith%20slash", {
      credentials: "include",
    });
  });
});
