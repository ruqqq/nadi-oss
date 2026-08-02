import { appFetch } from "./lib/app-fetch";
import { errorFromResponse } from "./lib/http-error";
import type { ModelInputModality } from "./settings-api";

type FetchLike = typeof fetch;
const JSON_HEADERS = { "Content-Type": "application/json" } as const;

export type AutomatonRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "waiting_for_approval"
  | "failed"
  | "skipped";

/**
 * Mirrors `AutomatonSchedule` in `src/automata/schedule.ts` — presets are a UI
 * affordance that each normalize to a cron expression on the Worker side.
 */
export type AutomatonSchedule =
  | { kind: "hourly"; minute: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekdays"; hour: number; minute: number }
  | { kind: "weekly"; weekday: number; hour: number; minute: number }
  | { kind: "cron"; expr: string };

export interface AutomatonSummary {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  agentId: string;
  projectId: string | null;
  workbenchId: string | null;
  name: string;
  prompt: string;
  /** Null means the automaton runs on the workspace agent's model. */
  modelProvider: string | null;
  model: string | null;
  modelInputModalities: string | null;
  scheduleJson: string;
  timezone: string;
  enabled: boolean;
  disabledReason: string | null;
  nextDueAt: number | null;
  lastFiredAt: number | null;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
  notifyMode: "all" | "failures_only";
  /** The automaton's most recent run, inlined by the list endpoint so the
   * list row's status chip doesn't need a per-item fetch. `null` if it has
   * never run. */
  lastRun: AutomatonRunSummary | null;
}

/** The subset of a run the list row's chip needs. Full history (all fields,
 * all runs) still comes from `getAutomaton`. */
export interface AutomatonRunSummary {
  id: string;
  status: AutomatonRunStatus;
  trigger: "scheduled" | "manual";
  startedAt: number | null;
  finishedAt: number | null;
  threadId: string | null;
  error: string | null;
}

export interface AutomatonRun {
  id: string;
  automatonId: string;
  workspaceId: string;
  dueAt: number | null;
  trigger: "scheduled" | "manual";
  threadId: string | null;
  status: AutomatonRunStatus;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type CreateAutomatonInput = {
  name: string;
  prompt: string;
  schedule: AutomatonSchedule;
  timezone: string;
  projectId?: string | null;
  workbenchId?: string | null;
  enabled?: boolean;
  notifyMode?: "all" | "failures_only";
  /** Send both, or both null to fall back to the workspace agent's model. */
  modelProvider?: string | null;
  model?: string | null;
  modelInputModalities?: ModelInputModality[] | null;
};

export type UpdateAutomatonInput = Partial<CreateAutomatonInput>;

export async function listAutomata(fetchImpl: FetchLike = appFetch): Promise<AutomatonSummary[]> {
  const res = await fetchImpl("/api/automata", { credentials: "include" });
  if (!res.ok) throw await errorFromResponse(res, "load your automata");
  const body = (await res.json()) as { automata: AutomatonSummary[] };
  return body.automata;
}

export async function getAutomaton(
  id: string,
  fetchImpl: FetchLike = appFetch,
): Promise<{ automaton: AutomatonSummary; runs: AutomatonRun[] }> {
  const res = await fetchImpl(`/api/automata/${encodeURIComponent(id)}`, {
    credentials: "include",
  });
  if (!res.ok) throw await errorFromResponse(res, "load this automaton");
  return (await res.json()) as { automaton: AutomatonSummary; runs: AutomatonRun[] };
}

export async function createAutomaton(
  input: CreateAutomatonInput,
  fetchImpl: FetchLike = appFetch,
): Promise<AutomatonSummary> {
  const res = await fetchImpl("/api/automata", {
    method: "POST",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await errorFromResponse(res, "create the automaton");
  const body = (await res.json()) as { automaton: AutomatonSummary };
  return body.automaton;
}

export async function updateAutomaton(
  id: string,
  input: UpdateAutomatonInput,
  fetchImpl: FetchLike = appFetch,
): Promise<AutomatonSummary> {
  const res = await fetchImpl(`/api/automata/${encodeURIComponent(id)}`, {
    method: "PATCH",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await errorFromResponse(res, "save the automaton");
  const body = (await res.json()) as { automaton: AutomatonSummary };
  return body.automaton;
}

export async function archiveAutomaton(
  id: string,
  fetchImpl: FetchLike = appFetch,
): Promise<AutomatonSummary> {
  const res = await fetchImpl(`/api/automata/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) throw await errorFromResponse(res, "delete the automaton");
  const body = (await res.json()) as { automaton: AutomatonSummary };
  return body.automaton;
}

export async function runAutomatonNow(
  id: string,
  fetchImpl: FetchLike = appFetch,
): Promise<{ runId: string; threadId: string }> {
  const res = await fetchImpl(`/api/automata/${encodeURIComponent(id)}/run`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw await errorFromResponse(res, "run this automaton");
  return (await res.json()) as { runId: string; threadId: string };
}

/**
 * Decodes the automaton's persisted `scheduleJson`. The value is always
 * written by `createAutomaton`/`updateAutomaton` through the Worker's own
 * `parseSchedule` validation, so this is a trusting decode, not a second
 * validator.
 */
export function parseAutomatonSchedule(scheduleJson: string): AutomatonSchedule {
  return JSON.parse(scheduleJson) as AutomatonSchedule;
}

// ---------------------------------------------------------------------------
// describeSchedule is duplicated (not imported) from `src/automata/schedule.ts`
// because the web bundle must not import Worker (`src/`) code. It is twelve
// lines; a shared package is not worth it. Keep both copies in sync — see
// `test/unit/automata/schedule.test.ts` for the Worker-side pinned cases.
// ---------------------------------------------------------------------------

const WEEKDAY_NAMES = [
  "Sundays",
  "Mondays",
  "Tuesdays",
  "Wednesdays",
  "Thursdays",
  "Fridays",
  "Saturdays",
];

const pad = (n: number) => String(n).padStart(2, "0");

export function describeSchedule(schedule: AutomatonSchedule): string {
  switch (schedule.kind) {
    case "hourly":
      return `Hourly at :${pad(schedule.minute)}`;
    case "daily":
      return `Daily at ${pad(schedule.hour)}:${pad(schedule.minute)}`;
    case "weekdays":
      return `Weekdays at ${pad(schedule.hour)}:${pad(schedule.minute)}`;
    case "weekly":
      return `${WEEKDAY_NAMES[schedule.weekday]} at ${pad(schedule.hour)}:${pad(schedule.minute)}`;
    case "cron":
      return `Custom (${schedule.expr})`;
  }
}
