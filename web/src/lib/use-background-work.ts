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

/** One row of the `listBackgroundWork` callable — mirrors the ledger's
 *  `WorkRow` shape (src/agent/work-ledger.ts), minus the fields the dock
 *  never renders (liveness bookkeeping, deadlines, generation). */
export interface BackgroundWorkRow {
  id: string;
  kind: BackgroundWorkKind;
  label: string | null;
  startedAt: number;
  terminal: { outcome: BackgroundWorkOutcome; reason: BackgroundWorkReason } | null;
}

/**
 * This thread's background work — processes and subagent runs together, with
 * the terminal outcome the two old per-kind views (`listActiveWatchers`, the
 * subagent event stream) could never both show. Reads the `listBackgroundWork`
 * callable, which is backed by the ledger (`WorkLedgerStore.listRecent`) —
 * open rows plus terminal rows the model was told about in the last 10
 * minutes, newest first.
 *
 * Refresh cadence mirrors `useWatcherRuns`: on mount/enable, on the message
 * stream (a completion delivery appends a message so the row's outcome lands
 * within one refetch), one delayed refetch to cover the turn-end sweep racing
 * the client's own refetch, and a steady safety poll so a silently-attached
 * row (no message) still surfaces within one interval.
 */
export function useBackgroundWork(
  agent: AgentSocket,
  messages: UIMessage[],
  enabled: boolean,
): { rows: BackgroundWorkRow[] } {
  const [rows, setRows] = useState<BackgroundWorkRow[]>([]);

  const agentRef = useRef(agent);
  agentRef.current = agent;

  const refresh = useRef(async () => {});
  refresh.current = async () => {
    if (!enabled) {
      setRows([]);
      return;
    }
    const result = (await agentRef.current.call("listBackgroundWork", [])) as BackgroundWorkRow[];
    setRows(Array.isArray(result) ? result : []);
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

  return { rows };
}
