import { useEffect, useRef, useState } from "react";
import type { UIMessage } from "ai";
import { useAgent } from "agents/react";
import type { ActiveWatcher } from "./watcher-runs";

// Same untyped-overload cast used by use-subagent-runs.ts.
type AgentSocket = ReturnType<typeof useAgent<unknown>> & {
  call(method: string, args: unknown[]): Promise<unknown>;
};

/**
 * Active exec_watch watchers for the current thread. Fetches via the
 * `listActiveWatchers` callable and refreshes whenever the message stream
 * changes — watch/unwatch are visible tool calls and a watcher firing appends a
 * (hidden) system-reminder message, so every add/remove/fire lands in
 * `messages`. A slow safety interval covers anything not reflected by a message.
 */
export function useWatcherRuns(
  agent: AgentSocket,
  messages: UIMessage[],
  enabled: boolean,
): { watchers: ActiveWatcher[] } {
  const [watchers, setWatchers] = useState<ActiveWatcher[]>([]);

  // Always reach the latest socket without re-subscribing effects each render.
  const agentRef = useRef(agent);
  agentRef.current = agent;

  const refresh = useRef(async () => {});
  refresh.current = async () => {
    if (!enabled) {
      setWatchers([]);
      return;
    }
    const rows = (await agentRef.current.call("listActiveWatchers", [])) as ActiveWatcher[];
    setWatchers(Array.isArray(rows) ? rows : []);
  };

  // Refresh on the message stream (add/remove/fire all land here) + on mount.
  const lastMessageId = messages.length > 0 ? messages[messages.length - 1]!.id : null;
  useEffect(() => {
    if (!enabled) {
      setWatchers([]);
      return;
    }
    void refresh.current().catch(() => {});
    // The turn-end backstop attaches watchers SILENTLY (no message), and the
    // server-side sweep commits just after the assistant message reaches the
    // client — so the immediate refetch above races that write. One short
    // delayed refetch surfaces a silently-attached watcher without perpetual
    // polling.
    const delayed = window.setTimeout(() => {
      void refresh.current().catch(() => {});
    }, 2500);
    return () => window.clearTimeout(delayed);
  }, [enabled, messages.length, lastMessageId]);

  // Safety poll while enabled. NOT gated on watchers.length: the turn-end
  // backstop attaches watchers SILENTLY (no message) and its server-side commit
  // can land after the message-driven refetches above, so a count-gated interval
  // would never start and a silently-attached watcher would never surface. A
  // steady poll is a cheap read-only callable; it guarantees the dock reflects
  // the store within one interval regardless of the sweep-commit race.
  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => {
      void refresh.current().catch(() => {});
    }, 5000);
    return () => window.clearInterval(id);
  }, [enabled]);

  return { watchers };
}
