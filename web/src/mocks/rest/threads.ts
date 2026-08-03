/**
 * `/api/threads*` handlers.
 *
 * The list endpoint is the one place the mock has to be exact: `listThreads`
 * dereferences `body.threads` with no fallback, and the cursor field is
 * `nextCursor` here but `threadsNextCursor` on `/api/bootstrap`. Mutations write
 * through to the store so the list, the sidebar, and the detail pane all agree.
 */

import { delay, http, HttpResponse } from "msw";
import type { ThreadSummary } from "../../threads-api";
import { getStore } from "../store";
import {
  errorResponse,
  historyUnreachable,
  mockId,
  notFound,
  paginate,
  pathParam,
  readLimit,
} from "./util";

/** The list filters `listThreads` can send, applied in the same order the
 *  query params are built. */
export function selectThreads(
  threads: ThreadSummary[],
  url: URL,
): { threads: ThreadSummary[]; nextCursor: string | null } {
  const status = url.searchParams.get("status") ?? "active";
  const project = url.searchParams.get("project");
  const projectId = url.searchParams.get("projectId");
  const q = url.searchParams.get("q");

  let filtered = threads.filter(
    (t) => t.kind !== "feedback" && (status === "all" || t.status === status),
  );
  if (project === "unassigned") {
    filtered = filtered.filter((t) => t.projectId === null);
  } else if (projectId) {
    filtered = filtered.filter((t) => t.projectId === projectId);
  }
  if (q) {
    const needle = q.toLowerCase();
    filtered = filtered.filter(
      (t) =>
        t.title.toLowerCase().includes(needle) ||
        t.lastMessagePreview.toLowerCase().includes(needle),
    );
  }
  filtered = [...filtered].sort((a, b) => b.updatedAt - a.updatedAt);

  const { page, nextCursor } = paginate(filtered, {
    limit: readLimit(url),
    cursor: url.searchParams.get("cursor"),
  });
  return { threads: page, nextCursor };
}

function find(threadId: string): ThreadSummary | undefined {
  return getStore().threads.find((t) => t.threadId === threadId);
}

export const threadHandlers = [
  http.get("/api/threads", ({ request }) => {
    const { threads, nextCursor } = selectThreads(getStore().threads, new URL(request.url));
    return HttpResponse.json({ threads, nextCursor });
  }),

  http.post("/api/threads", async ({ request }) => {
    const store = getStore();
    const input = (await request.json().catch(() => ({}))) as {
      provider?: string;
      model?: string;
      modelInputModalities?: ThreadSummary["modelInputModalities"];
      showReasoning?: boolean;
      reasoningEffort?: string;
      modelSupportsReasoning?: boolean | null;
      projectId?: string | null;
      workbenchId?: string | null;
    };
    const project = store.projects.find((p) => p.id === input.projectId);
    const workbench = store.workbenches.find((w) => w.id === input.workbenchId);
    const now = Date.now();
    const thread: ThreadSummary = {
      threadId: mockId("thr"),
      kind: "regular",
      workspaceId: store.settings?.workspace.id ?? "ws_mock",
      agentId: store.settings?.agent.id ?? "agent_mock",
      provider: input.provider ?? store.settings?.agent.provider ?? "anthropic",
      model: input.model ?? store.settings?.agent.model ?? "claude-sonnet-4-5",
      modelInputModalities: input.modelInputModalities ?? ["text"],
      showReasoning: input.showReasoning ?? false,
      reasoningEffort:
        input.reasoningEffort === "off" ||
        input.reasoningEffort === "low" ||
        input.reasoningEffort === "medium" ||
        input.reasoningEffort === "high"
          ? input.reasoningEffort
          : (store.settings?.agent.reasoningEffort ?? "medium"),
      modelSupportsReasoning:
        input.modelSupportsReasoning !== undefined
          ? input.modelSupportsReasoning
          : (store.settings?.agent.modelSupportsReasoning ?? null),
      runtime: "think",
      title: "New chat",
      source: "manual",
      lastMessagePreview: "",
      archivedAt: null,
      readOnly: false,
      status: "active",
      projectId: project?.id ?? null,
      projectName: project?.name ?? null,
      workbenchId: workbench?.id ?? null,
      workbenchName: workbench?.name ?? null,
      workbenchSwitchPending: false,
      resourceProfile: workbench?.resourceProfile ?? "small",
      automatonId: null,
      automatonName: null,
      automatonNotifyMode: null,
      outcomeDismissedAt: null,
      recentDismissedAt: null,
      repositorySnapshotCount: 0,
      lastContextTokens: null,
      lastContextWindow: null,
      lastCompactAfterTokens: null,
      createdAt: now,
      updatedAt: now,
    };
    store.threads.unshift(thread);
    return HttpResponse.json({ thread }, { status: 201 });
  }),

  http.post("/api/threads/reconcile", async ({ request }) => {
    const body = (await request.json().catch(() => null)) as { threadIds?: unknown } | null;
    const threadIds = body?.threadIds;
    if (
      !Array.isArray(threadIds) ||
      threadIds.length === 0 ||
      threadIds.length > 100 ||
      !threadIds.every((id) => typeof id === "string" && id.trim().length > 0) ||
      new Set(threadIds).size !== threadIds.length
    ) {
      return errorResponse(400, "Invalid threadIds");
    }
    const active = new Set(
      getStore()
        .threads.filter((thread) => thread.status === "active")
        .map((thread) => thread.threadId),
    );
    return HttpResponse.json({ activeThreadIds: threadIds.filter((id) => active.has(id)) });
  }),

  http.get("/api/threads/:threadId", ({ params }) => {
    const thread = find(pathParam(params, "threadId"));
    if (!thread) return notFound("That chat");
    return HttpResponse.json({ thread });
  }),

  http.patch("/api/threads/:threadId", async ({ params, request }) => {
    const store = getStore();
    const thread = find(pathParam(params, "threadId"));
    if (!thread) return notFound("That chat");
    const patch = (await request.json().catch(() => ({}))) as {
      title?: string;
      projectId?: string | null;
      workbenchId?: string | null;
      reasoningEffort?: string;
    };
    if (typeof patch.title === "string") thread.title = patch.title;
    if (
      patch.reasoningEffort === "off" ||
      patch.reasoningEffort === "low" ||
      patch.reasoningEffort === "medium" ||
      patch.reasoningEffort === "high"
    ) {
      thread.reasoningEffort = patch.reasoningEffort;
    } else if (patch.reasoningEffort !== undefined) {
      return errorResponse(400, "reasoningEffort must be one of off, low, medium, high");
    }
    if (patch.projectId !== undefined) {
      const project = store.projects.find((p) => p.id === patch.projectId);
      thread.projectId = project?.id ?? null;
      thread.projectName = project?.name ?? null;
    }
    if (patch.workbenchId !== undefined) {
      const nextWorkbench = store.workbenches.find((w) => w.id === patch.workbenchId);
      // A live sandbox defers: the model has no exec/sandbox lifecycle to
      // inspect, so a thread that already had a workbench assigned stands in
      // for "a sandbox may be running". `resourceProfile` (the frozen
      // snapshot) intentionally does NOT move here — the real server only
      // re-snapshots when the switch commits, so the mock must keep showing
      // the OLD size while `workbenchSwitchPending` is true, exactly what a
      // pending switch looks like for real.
      const isRealChange = patch.workbenchId !== thread.workbenchId;
      const hadLiveSandbox = thread.workbenchId !== null;
      thread.workbenchId = nextWorkbench?.id ?? null;
      thread.workbenchName = nextWorkbench?.name ?? null;
      if (isRealChange && hadLiveSandbox) {
        thread.workbenchSwitchPending = true;
      } else {
        thread.workbenchSwitchPending = false;
        thread.resourceProfile = nextWorkbench?.resourceProfile ?? "small";
      }
    }
    thread.updatedAt = Date.now();
    return HttpResponse.json({ thread });
  }),

  http.delete("/api/threads/:threadId", ({ params }) => {
    const store = getStore();
    const threadId = pathParam(params, "threadId");
    const index = store.threads.findIndex((t) => t.threadId === threadId);
    if (index === -1) return notFound("That chat");
    store.threads.splice(index, 1);
    return new HttpResponse(null, { status: 204 });
  }),

  http.post("/api/threads/:threadId/archive", ({ params }) => {
    const thread = find(pathParam(params, "threadId"));
    if (!thread) return notFound("That chat");
    if (thread.status === "archived") {
      return errorResponse(409, "This chat is already archived.");
    }
    thread.status = "archived";
    thread.archivedAt = Date.now();
    thread.readOnly = true;
    thread.updatedAt = Date.now();
    return HttpResponse.json({ thread });
  }),

  http.post("/api/threads/:threadId/seen", ({ params }) => {
    const thread = find(pathParam(params, "threadId"));
    if (!thread) return notFound("That chat");
    thread.lastSeenAt = Date.now();
    thread.unreadOutcome = null;
    thread.unreadOutcomeAt = null;
    return HttpResponse.json({ thread });
  }),

  // Mirrors the server: the dismissal stamp moves, `updatedAt` does not. The
  // rail's predicate compares the two, so a bump here would make the mocked app
  // disagree with production about whether dismissal works at all.
  http.post("/api/threads/:threadId/dismiss-recent", ({ params }) => {
    const thread = find(pathParam(params, "threadId"));
    if (!thread) return notFound("That chat");
    thread.recentDismissedAt = Date.now();
    return HttpResponse.json({ thread });
  }),

  http.delete("/api/threads/:threadId/dismiss-recent", ({ params }) => {
    const thread = find(pathParam(params, "threadId"));
    if (!thread) return notFound("That chat");
    thread.recentDismissedAt = null;
    return HttpResponse.json({ thread });
  }),

  http.post("/api/threads/:threadId/dismiss-outcome", ({ params }) => {
    const thread = find(pathParam(params, "threadId"));
    if (!thread) return notFound("That chat");
    thread.outcomeDismissedAt = Date.now();
    thread.unreadOutcome = null;
    return HttpResponse.json({ thread });
  }),

  http.post("/api/threads/:threadId/compact", ({ params }) => {
    const thread = find(pathParam(params, "threadId"));
    if (!thread) return notFound("That chat");
    thread.lastContextTokens = 8_000;
    return HttpResponse.json({ compacted: true, message: "Compacted the conversation." });
  }),

  http.get("/api/threads/:threadId/compact/status", () => HttpResponse.json({ phase: "idle" })),

  // Bare array on purpose — `fetchArchivedSummaries` casts the body directly.
  http.get("/api/threads/:threadId/summaries", () => HttpResponse.json([])),

  /**
   * First-message delivery. 204 normally; the `messageSendFailsAfterMs` fault
   * stalls it and then fails so the optimistic bubble is observable in
   * `sending` before it settles on `failed`.
   */
  http.post("/api/threads/:threadId/messages", async () => {
    const stallMs = getStore().faults.messageSendFailsAfterMs;
    if (stallMs === null) return new HttpResponse(null, { status: 204 });
    await delay(stallMs);
    return errorResponse(503, "Nadi couldn't accept the message right now.");
  }),

  /**
   * Archived-thread history. `thread-history-fetch.ts` accepts a bare array or
   * `{messages}`; anything else is treated as a degraded load. The scripted
   * transcripts belong to the fake chat hook (Task 4), so this serves an empty
   * transcript rather than inventing a second source of truth.
   */
  http.get("/api/threads/:threadId/messages", ({ params }) => {
    if (historyUnreachable(pathParam(params, "threadId"))) return HttpResponse.error();
    return HttpResponse.json({ messages: [] });
  }),
];
