/**
 * `/api/automata*`. `DELETE` archives (and returns `{automaton}`), matching
 * `archiveAutomaton`; `POST /:id/run` returns `{runId, threadId}` and seeds a
 * thread so the run's link resolves.
 */

import { http, HttpResponse } from "msw";
import type { AutomatonRun, AutomatonSchedule, AutomatonSummary } from "../../automata-api";
import { getStore } from "../store";
import { mockId, notFound, pathParam } from "./util";

type AutomatonInput = {
  name?: string;
  prompt?: string;
  schedule?: AutomatonSchedule;
  timezone?: string;
  projectId?: string | null;
  workbenchId?: string | null;
  enabled?: boolean;
  notifyMode?: "all" | "failures_only";
  modelProvider?: string | null;
  model?: string | null;
};

function mockNextDueAt(schedule: AutomatonSchedule): number | null {
  const now = Date.now();
  if (schedule.kind === "once") {
    return schedule.runAt > now ? schedule.runAt : null;
  }
  return now + 3_600_000;
}

/** The run history `getAutomaton` returns. Derived from `lastRun` so the detail
 *  view can't disagree with the list row's chip. */
function runsFor(automaton: AutomatonSummary): AutomatonRun[] {
  const last = automaton.lastRun;
  if (!last) return [];
  return [
    {
      id: last.id,
      automatonId: automaton.id,
      workspaceId: automaton.workspaceId,
      dueAt: last.startedAt,
      trigger: last.trigger,
      threadId: last.threadId,
      status: last.status,
      error: last.error,
      startedAt: last.startedAt,
      finishedAt: last.finishedAt,
      createdAt: last.startedAt ?? automaton.createdAt,
      updatedAt: last.finishedAt ?? automaton.updatedAt,
    },
  ];
}

export const automataHandlers = [
  http.get("/api/automata", () =>
    HttpResponse.json({
      automata: getStore().automata.filter((a) => a.archivedAt === null),
    }),
  ),

  http.post("/api/automata", async ({ request }) => {
    const store = getStore();
    const input = (await request.json().catch(() => ({}))) as AutomatonInput;
    const name = (input.name ?? "").trim();
    if (!name) return HttpResponse.json({ error: "An automaton needs a name." }, { status: 400 });
    const now = Date.now();
    const schedule = input.schedule ?? { kind: "daily", hour: 9, minute: 0 };
    const automaton: AutomatonSummary = {
      id: mockId("atm"),
      workspaceId: store.settings?.workspace.id ?? "ws_mock",
      ownerUserId: store.session.authenticated ? store.session.user.id : "user_mock",
      agentId: store.settings?.agent.id ?? "agent_mock",
      projectId: input.projectId ?? null,
      // Echo the workbench override back so the form's picker round-trips.
      workbenchId: input.workbenchId ?? null,
      name,
      prompt: input.prompt ?? "",
      modelProvider: input.modelProvider ?? null,
      model: input.model ?? null,
      modelInputModalities: null,
      scheduleJson: JSON.stringify(schedule),
      timezone: input.timezone ?? "UTC",
      enabled: input.enabled ?? true,
      disabledReason: null,
      nextDueAt: mockNextDueAt(schedule),
      lastFiredAt: null,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
      notifyMode: input.notifyMode ?? "all",
      lastRun: null,
    };
    store.automata.push(automaton);
    return HttpResponse.json({ automaton }, { status: 201 });
  }),

  http.get("/api/automata/:automatonId", ({ params }) => {
    const automaton = getStore().automata.find((a) => a.id === pathParam(params, "automatonId"));
    if (!automaton) return notFound("That automaton");
    return HttpResponse.json({ automaton, runs: runsFor(automaton) });
  }),

  http.patch("/api/automata/:automatonId", async ({ params, request }) => {
    const automaton = getStore().automata.find((a) => a.id === pathParam(params, "automatonId"));
    if (!automaton) return notFound("That automaton");
    const patch = (await request.json().catch(() => ({}))) as AutomatonInput;
    if (typeof patch.name === "string") automaton.name = patch.name;
    if (typeof patch.prompt === "string") automaton.prompt = patch.prompt;
    if (patch.schedule) {
      automaton.scheduleJson = JSON.stringify(patch.schedule);
      automaton.nextDueAt = mockNextDueAt(patch.schedule);
    }
    if (typeof patch.timezone === "string") automaton.timezone = patch.timezone;
    if (patch.projectId !== undefined) automaton.projectId = patch.projectId;
    if (patch.workbenchId !== undefined) automaton.workbenchId = patch.workbenchId;
    if (typeof patch.enabled === "boolean") {
      if (patch.enabled) {
        const schedule = JSON.parse(automaton.scheduleJson) as AutomatonSchedule;
        if (schedule.kind === "once" && schedule.runAt <= Date.now()) {
          return HttpResponse.json({ error: "Pick a new time before enabling." }, { status: 400 });
        }
        automaton.enabled = true;
        automaton.disabledReason = null;
        if (schedule.kind === "once") automaton.nextDueAt = schedule.runAt;
      } else {
        automaton.enabled = false;
        automaton.disabledReason = "Paused by owner";
      }
    }
    if (patch.notifyMode) automaton.notifyMode = patch.notifyMode;
    if (patch.modelProvider !== undefined) automaton.modelProvider = patch.modelProvider;
    if (patch.model !== undefined) automaton.model = patch.model;
    automaton.updatedAt = Date.now();
    return HttpResponse.json({ automaton });
  }),

  http.delete("/api/automata/:automatonId", ({ params }) => {
    const automaton = getStore().automata.find((a) => a.id === pathParam(params, "automatonId"));
    if (!automaton) return notFound("That automaton");
    automaton.archivedAt = Date.now();
    automaton.enabled = false;
    automaton.updatedAt = Date.now();
    return HttpResponse.json({ automaton });
  }),

  http.post("/api/automata/:automatonId/run", ({ params }) => {
    const store = getStore();
    const automaton = store.automata.find((a) => a.id === pathParam(params, "automatonId"));
    if (!automaton) return notFound("That automaton");
    const now = Date.now();
    const runId = mockId("run");
    const threadId = mockId("thr");
    store.threads.unshift({
      threadId,
      kind: "regular",
      workspaceId: automaton.workspaceId,
      agentId: automaton.agentId,
      provider: automaton.modelProvider ?? store.settings?.agent.provider ?? "anthropic",
      model: automaton.model ?? store.settings?.agent.model ?? "claude-sonnet-4-5",
      modelInputModalities: ["text"],
      reasoningEffort: store.settings?.agent.reasoningEffort ?? "medium",
      modelSupportsReasoning: store.settings?.agent.modelSupportsReasoning ?? null,
      runtime: "think",
      title: automaton.name,
      source: "automaton",
      lastMessagePreview: "",
      activityStatus: "running",
      currentTurnStartedAt: now,
      archivedAt: null,
      readOnly: false,
      status: "active",
      projectId: automaton.projectId,
      projectName: store.projects.find((p) => p.id === automaton.projectId)?.name ?? null,
      workbenchId: null,
      workbenchName: null,
      resourceProfile: "small",
      automatonId: automaton.id,
      automatonName: automaton.name,
      automatonNotifyMode: automaton.notifyMode,
      outcomeDismissedAt: null,
      recentDismissedAt: null,
      repositorySnapshotCount: 0,
      lastContextTokens: null,
      lastContextWindow: null,
      lastCompactAfterTokens: null,
      createdAt: now,
      updatedAt: now,
    });
    automaton.lastFiredAt = now;
    automaton.lastRun = {
      id: runId,
      status: "running",
      trigger: "manual",
      startedAt: now,
      finishedAt: null,
      threadId,
      error: null,
    };
    return HttpResponse.json({ runId, threadId });
  }),
];
