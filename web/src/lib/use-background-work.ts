import { useEffect, useRef, useState } from "react";
import type { UIMessage } from "ai";
import { useAgent } from "agents/react";

// Same untyped-overload cast used by use-pending-steers.ts.
type AgentSocket = ReturnType<typeof useAgent<unknown>> & {
  call(method: string, args: unknown[]): Promise<unknown>;
};

export type BackgroundWorkKind = "process" | "subagent";
export type BackgroundWorkOutcome = "exited" | "stopped" | "timeout" | "fault";
export type BackgroundWorkReason =
  | "process_exit"
  | "process_stopped"
  | "watch_timeout"
  | "sandbox_reset"
  | "no_liveness";

export type BackgroundWorkOutputStream = "stdout" | "stderr";

/** The SDK terminal status a `subagent` row carries. A subagent's `outcome`
 *  cannot express this: `error` and `interrupted` both arrive as `"exited"`,
 *  so this is the ONLY field that separates a completed subagent from a
 *  crashed one. `null` on every `process` row, and on a subagent row whose
 *  status the server didn't recognize. */
export type SubagentTerminalStatus = "completed" | "error" | "aborted" | "interrupted";

/** The closed set `cancelBackgroundWork` returns in `reason` when `ok:false`
 *  — the client switches on this, never on raw error text. */
export type BackgroundWorkCancelReason =
  | "background_work_disabled"
  | "unknown_id"
  | "already_terminal"
  | "sandbox_disabled"
  | "cancel_failed";

/** One row of the `listBackgroundWork` callable — mirrors the ledger's
 *  `WorkRow` shape (src/agent/work-ledger.ts), minus the fields the dock
 *  never renders (liveness bookkeeping, deadlines, generation).
 *
 * `exitCode` is deliberately NOT optional: `number | null` keeps "the process
 * told us 0" and "we never got a code" as two distinct, exhaustively-checked
 * states. An optional field would let `undefined` and `null` collapse into
 * the same falsy branch, and that branch is exactly where a false "clean
 * exit" would hide a real failure. */
export interface BackgroundWorkRow {
  id: string;
  kind: BackgroundWorkKind;
  label: string | null;
  startedAt: number;
  /** Last `reportProgress` signal of a RUNNING subagent, from the SDK's
   * durable child-run row — so it is present regardless of when this client
   * connected. `null` for a process row, a finished row, and a subagent that
   * hasn't reported yet. */
  progress: { message: string | null; phase: string | null; at: number } | null;
  terminal: {
    outcome: BackgroundWorkOutcome;
    reason: BackgroundWorkReason;
    exitCode: number | null;
    subagentStatus: SubagentTerminalStatus | null;
    /** Wall-clock time the ledger recorded this row as terminal
     * (`WorkTerminal.at`) — the sheet derives a finished row's duration from
     * `at - startedAt`, NOT from wall-clock-now, so a reload doesn't reset
     * every finished row's elapsed time to "however long ago I opened the
     * sheet". */
    at: number;
  } | null;
}

const SUBAGENT_TERMINAL_STATUSES: readonly string[] = [
  "completed",
  "error",
  "aborted",
  "interrupted",
];

/**
 * Did this row finish successfully? Kind-aware, and it MUST be: the two kinds
 * disagree about what an absent exit code means. A process with no code is an
 * unconfirmed exit (never clean); a subagent NEVER has a code, so the same
 * test called every finished subagent a failure — the bug this function
 * exists to prevent recurring. A subagent's success lives in
 * `subagentStatus`, whose absence is likewise unconfirmed, never clean.
 *
 * Shared by both surfaces (the dock summary row and the sheet) so the two can
 * never drift into disagreeing about whether a task failed.
 */
export function isBackgroundWorkClean(row: BackgroundWorkRow): boolean {
  if (row.terminal === null) return false;
  if (row.kind === "subagent") return row.terminal.subagentStatus === "completed";
  return row.terminal.outcome === "exited" && row.terminal.exitCode === 0;
}

/**
 * Did this row finish UNsuccessfully? Deliberately not `!isClean`: a row with
 * no confirmed outcome (a process with no exit code, a subagent with an
 * unrecognized status) is neither, and calling it a failure would cry wolf on
 * every degraded status read. Callers with only two buckets must decide which
 * side "unconfirmed" belongs on themselves.
 */
export function isBackgroundWorkFailed(row: BackgroundWorkRow): boolean {
  if (row.terminal === null) return false;
  if (row.kind === "subagent") {
    const status = row.terminal.subagentStatus;
    return status !== null && status !== "completed";
  }
  if (row.terminal.outcome !== "exited") return true; // stopped | timeout | fault
  return row.terminal.exitCode !== null && row.terminal.exitCode !== 0;
}

export interface BackgroundWorkOutput {
  head: string[];
  tail: string[];
  hiddenLines: number;
  truncated: boolean;
  stream: BackgroundWorkOutputStream;
}

/** Exported for its own test: this is the last line of defence for the bug
 * this task exists to fix. Loosening `BackgroundWorkRow.terminal.exitCode`
 * (or `at`) back to optional would break no OTHER test in this codebase —
 * `use-background-work.ts` otherwise has no test file — so the guard needs
 * one of its own. */
export function isBackgroundWorkRow(value: unknown): value is BackgroundWorkRow {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string") return false;
  if (row.kind !== "process" && row.kind !== "subagent") return false;
  if (typeof row.startedAt !== "number") return false;
  if (row.progress !== null) {
    if (typeof row.progress !== "object") return false;
    const progress = row.progress as Record<string, unknown>;
    if (typeof progress.message !== "string" && progress.message !== null) return false;
    if (typeof progress.phase !== "string" && progress.phase !== null) return false;
    if (typeof progress.at !== "number") return false;
  }
  if (row.terminal !== null) {
    if (typeof row.terminal !== "object") return false;
    const terminal = row.terminal as Record<string, unknown>;
    if (typeof terminal.outcome !== "string") return false;
    if (typeof terminal.reason !== "string") return false;
    if (typeof terminal.exitCode !== "number" && terminal.exitCode !== null) return false;
    // Rejected rather than coerced to null: a subagent row whose status field
    // is missing entirely means an OLD server is answering a new client, and
    // `isBackgroundWorkClean` would read that absence as "not completed" —
    // silently mislabelling every successful subagent as it did before this
    // field existed. Dropping the row shows nothing, which is visibly wrong
    // rather than confidently wrong.
    if (
      terminal.subagentStatus !== null &&
      !SUBAGENT_TERMINAL_STATUSES.includes(terminal.subagentStatus as string)
    ) {
      return false;
    }
    if (typeof terminal.at !== "number") return false;
  }
  return true;
}

/**
 * This thread's background work — processes and subagent runs together, with
 * the terminal outcome the two old per-kind views (`listActiveWatchers`, the
 * subagent event stream) could never both show. Reads the `listBackgroundWork`
 * callable, which is backed by the ledger (`WorkLedgerStore.listRecent`) —
 * open rows, rows delivered in the last 10 minutes, AND any row still owed a
 * delivery (terminal but not yet told to the model — see `listRecent`'s doc),
 * newest first.
 *
 * Refresh cadence mirrors the deleted `useWatcherRuns`: on mount/enable, on
 * the message stream (a completion delivery appends a message so the row's
 * outcome lands within one refetch), one delayed refetch to cover the
 * turn-end sweep racing the client's own refetch, and a steady safety poll so
 * a silently-attached row (no message) still surfaces within one interval.
 *
 * Also exposes the three action callables the sheet needs
 * (`readBackgroundWorkOutput`, `cancelBackgroundWork`,
 * `clearFinishedBackgroundWork`) so the sheet never has to reach for the raw
 * socket itself.
 */
export function useBackgroundWork(
  agent: AgentSocket,
  messages: UIMessage[],
  enabled: boolean,
): {
  rows: BackgroundWorkRow[];
  refresh: () => Promise<void>;
  readOutput: (
    processId: string,
    stream?: BackgroundWorkOutputStream,
  ) => Promise<BackgroundWorkOutput | null>;
  cancel: (id: string) => Promise<{ ok: boolean; reason?: BackgroundWorkCancelReason }>;
  clearFinished: () => Promise<{ cleared: number }>;
} {
  const [rows, setRows] = useState<BackgroundWorkRow[]>([]);

  const agentRef = useRef(agent);
  agentRef.current = agent;

  const refresh = useRef(async () => {});
  refresh.current = async () => {
    if (!enabled) {
      setRows([]);
      return;
    }
    const result = await agentRef.current.call("listBackgroundWork", []);
    setRows(Array.isArray(result) ? result.filter(isBackgroundWorkRow) : []);
  };

  const lastMessageId = messages.length > 0 ? messages[messages.length - 1]!.id : null;
  useEffect(() => {
    if (!enabled) {
      setRows([]);
      return;
    }
    void refresh.current().catch(() => {});
    const delayed = window.setTimeout(() => {
      void refresh.current().catch(() => {});
    }, 2500);
    return () => window.clearTimeout(delayed);
  }, [enabled, messages.length, lastMessageId]);

  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => {
      void refresh.current().catch(() => {});
    }, 5000);
    return () => window.clearInterval(id);
  }, [enabled]);

  const readOutput = useRef(
    async (
      processId: string,
      stream?: BackgroundWorkOutputStream,
    ): Promise<BackgroundWorkOutput | null> => {
      const args = stream ? [processId, stream] : [processId];
      const result = await agentRef.current.call("readBackgroundWorkOutput", args);
      return (result as BackgroundWorkOutput | null) ?? null;
    },
  ).current;

  const cancel = useRef(
    async (id: string): Promise<{ ok: boolean; reason?: BackgroundWorkCancelReason }> => {
      const result = await agentRef.current.call("cancelBackgroundWork", [id]);
      return result as { ok: boolean; reason?: BackgroundWorkCancelReason };
    },
  ).current;

  const clearFinished = useRef(async (): Promise<{ cleared: number }> => {
    const result = await agentRef.current.call("clearFinishedBackgroundWork", []);
    return result as { cleared: number };
  }).current;

  return { rows, refresh: refresh.current, readOutput, cancel, clearFinished };
}
