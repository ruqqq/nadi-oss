import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UIMessage } from "ai";
import { useAgent, useAgentToolEvents } from "agents/react";
import { effectiveRunTiming, type SubagentRunView } from "./subagent-runs";

/** Per-run server timing from the parent's `getSubagentRunTimings` callable
 *  (Task 5) — `startedAt` survives a page refresh, unlike a client-side
 *  first-seen timestamp. Keyed by `runId`. */
export type SubagentRunTimings = Record<string, { startedAt?: number; finishedAt?: number }>;

// Bind the State type param so this resolves to useAgent's untyped overload
// (call: UntypedAgentMethodCall) — the same one App.tsx's `useAgent({...})`
// call resolves to. Bare `ReturnType<typeof useAgent>` picks the stricter
// AgentMethodCall overload, which the untyped socket is not assignable to.
type AgentSocket = ReturnType<typeof useAgent<unknown>> & {
  call(method: string, args: unknown[]): Promise<unknown>;
};

/** The run state we consume also carries the child's streamed message parts. */
export type SubagentRunWithParts = SubagentRunView & { parts?: UIMessage["parts"] };

/** completed | error | aborted — the terminal set the backend's
 *  clearFinishedSubagentRuns clears (a still-live "interrupted" run is NOT). */
function isClearable(status: SubagentRunView["status"]): boolean {
  return status === "completed" || status === "error" || status === "aborted";
}

export interface SubagentRunsState {
  /** All live runs keyed by id — lets a completion message join its run. */
  runsById: Record<string, SubagentRunWithParts>;
  /** Dock-visible runs (dismissed ones removed), running first then newest. */
  runs: SubagentRunWithParts[];
  runningCount: number;
  finishedCount: number;
  /** Sort-order bookkeeping only — see `runDurationLabel` (subagent-runs.ts)
   *  + `timings` below for the duration label, which must survive a refresh. */
  firstSeen: Map<string, number>;
  /** Server-persisted start/finish per run, for `runDurationLabel`. */
  timings: SubagentRunTimings;
  cancelRun: (runId: string) => void;
  clearFinished: () => void;
  hasFinished: boolean;
}

/**
 * Wraps the SDK's `useAgentToolEvents` for the parent socket: exposes the runs,
 * records a client-side first-seen timestamp per run (for sort order), fetches
 * the server-persisted run timings (for the duration label — survives a page
 * refresh, unlike a client-side timestamp), and binds the parent callables via
 * `agent.call`.
 */
export function useSubagentRuns(agent: AgentSocket, enabled: boolean): SubagentRunsState {
  const events = useAgentToolEvents<UIMessage["parts"][number]>({ agent });
  const runsById = events.runsById as unknown as Record<string, SubagentRunWithParts>;

  // First-seen is client render time and is used ONLY to order the dock
  // (running-first, then newest-first) — entries are never pruned, a slow
  // leak on a very long-lived thread, acceptable for sort bookkeeping. It must
  // NOT be used for the duration label: it resets on every page refresh, which
  // is exactly the bug `timings` (below) fixes.
  const firstSeen = useRef<Map<string, number>>(new Map());
  for (const runId of Object.keys(runsById)) {
    if (!firstSeen.current.has(runId)) firstSeen.current.set(runId, Date.now());
  }

  // Client-observed terminal timestamp per run — the fallback end for the
  // duration label when the server's `finishedAt` is missing or lags the status
  // change, so a finished chip's timer freezes instead of tracking the shared
  // live ticker. Captured once when a run first enters the clearable-terminal
  // set; cleared if a run goes back to `running` (defensive against a resume).
  const terminalAt = useRef<Map<string, number>>(new Map());
  for (const run of Object.values(runsById)) {
    if (run.status === "running") {
      terminalAt.current.delete(run.runId);
    } else if (isClearable(run.status) && !terminalAt.current.has(run.runId)) {
      terminalAt.current.set(run.runId, Date.now());
    }
  }

  // Server-persisted start/finish per run (Task 5's `getSubagentRunTimings`).
  // Re-fetched whenever the run set or any run's status changes — that
  // cadence covers both a newly dispatched run (need its startedAt) and a run
  // going terminal (need its finishedAt) — including the very first render
  // after a page refresh, when runsById is already populated from replayed
  // state but this hook's own timings state starts empty.
  const [timings, setTimings] = useState<SubagentRunTimings>({});
  const runStateKey = Object.values(runsById)
    .map((run) => `${run.runId}:${run.status}`)
    .sort()
    .join(",");
  useEffect(() => {
    if (!enabled || runStateKey === "") return;
    let cancelled = false;
    void (agent.call("getSubagentRunTimings", []) as Promise<SubagentRunTimings>)
      .then((result) => {
        if (!cancelled) setTimings(result ?? {});
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [agent, enabled, runStateKey]);

  // Runs the user has cleared from the dock. clearAgentToolRuns does not
  // reliably broadcast a removal to this client, so we hide them locally too —
  // otherwise "Clear finished" would appear to do nothing.
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());

  const runs = useMemo(() => {
    return Object.values(runsById)
      .filter((run) => !dismissed.has(run.runId))
      .sort((a, b) => {
        const aRunning = a.status === "running" ? 0 : 1;
        const bRunning = b.status === "running" ? 0 : 1;
        if (aRunning !== bRunning) return aRunning - bRunning;
        return (firstSeen.current.get(b.runId) ?? 0) - (firstSeen.current.get(a.runId) ?? 0);
      });
  }, [runsById, dismissed]);

  const runningCount = runs.filter((run) => run.status === "running").length;
  const finishedCount = runs.filter((run) => isClearable(run.status)).length;

  const cancelRun = useCallback(
    (runId: string) => {
      if (!enabled) return;
      void (agent.call("cancelSubagentRun", [runId]) as Promise<unknown>).catch(() => {});
    },
    [agent, enabled],
  );

  const clearFinished = useCallback(() => {
    if (!enabled) return;
    const clearable = Object.values(runsById)
      .filter((run) => isClearable(run.status))
      .map((run) => run.runId);
    if (clearable.length > 0) setDismissed((prev) => new Set([...prev, ...clearable]));
    void (agent.call("clearFinishedSubagentRuns", []) as Promise<unknown>).catch(() => {});
  }, [agent, enabled, runsById]);

  // Fold the client terminal-timestamp fallback into the server timings so a
  // finished run's duration freezes even before (or without) a persisted
  // `finishedAt`. Recomputes when the run set or a run's status changes.
  const effectiveTimings = useMemo(() => {
    const out: SubagentRunTimings = {};
    for (const runId of Object.keys(runsById)) {
      out[runId] = effectiveRunTiming(timings[runId], terminalAt.current.get(runId));
    }
    return out;
    // terminalAt is a ref mutated in render above; runsById changing on a status
    // transition is what re-runs this, at which point the ref is already updated.
  }, [runsById, timings]);

  return {
    runsById,
    runs,
    runningCount,
    finishedCount,
    firstSeen: firstSeen.current,
    timings: effectiveTimings,
    cancelRun,
    clearFinished,
    hasFinished: finishedCount > 0,
  };
}
