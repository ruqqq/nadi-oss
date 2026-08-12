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
  terminal: {
    outcome: BackgroundWorkOutcome;
    reason: BackgroundWorkReason;
    exitCode: number | null;
    /** Wall-clock time the ledger recorded this row as terminal
     * (`WorkTerminal.at`) — the sheet derives a finished row's duration from
     * `at - startedAt`, NOT from wall-clock-now, so a reload doesn't reset
     * every finished row's elapsed time to "however long ago I opened the
     * sheet". */
    at: number;
  } | null;
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
  if (row.terminal !== null) {
    if (typeof row.terminal !== "object") return false;
    const terminal = row.terminal as Record<string, unknown>;
    if (typeof terminal.outcome !== "string") return false;
    if (typeof terminal.reason !== "string") return false;
    if (typeof terminal.exitCode !== "number" && terminal.exitCode !== null) return false;
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
