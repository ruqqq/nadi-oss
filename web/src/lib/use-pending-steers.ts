import { useCallback, useEffect, useRef, useState } from "react";
import { useAgent } from "agents/react";

// Same untyped-overload cast used by use-background-work.ts.
type AgentSocket = ReturnType<typeof useAgent<unknown>> & {
  call(method: string, args: unknown[]): Promise<unknown>;
};

/**
 * Poll `pendingSteerKeys` for the current thread while there are active steers.
 * The Steering→Sent flip fires when `beforeStep` drains the buffer, which does
 * NOT broadcast a message — so a message-stream-driven refresh can't observe it;
 * a short interval does. Polls only while `hasActiveSteers`, so an idle thread
 * makes no calls.
 *
 * Returns TWO sets so the chip state can tell "not drained yet" from "never
 * observed yet" — critical to avoid a false "Sent" flash on a brand-new steer
 * (absent from `pendingKeys` only because no poll has run). `seenKeys` is the
 * grown-only union of every key ever observed in the buffer; a steer is only
 * "Sent" once it is absent from `pendingKeys` AND present in `seenKeys` (seen,
 * then gone). Cleared when no steers are active, so it stays bounded.
 */
export function usePendingSteers(
  agent: AgentSocket,
  enabled: boolean,
  hasActiveSteers: boolean,
): { pendingKeys: Set<string>; seenKeys: Set<string>; refresh: () => Promise<void> } {
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(() => new Set());
  const [seenKeys, setSeenKeys] = useState<Set<string>>(() => new Set());

  const agentRef = useRef(agent);
  agentRef.current = agent;

  const refresh = useRef(async () => {});
  refresh.current = async () => {
    if (!enabled) {
      setPendingKeys(new Set());
      return;
    }
    const keys = (await agentRef.current.call("pendingSteerKeys", [])) as string[];
    const next = new Set(Array.isArray(keys) ? keys : []);
    setPendingKeys(next);
    setSeenKeys((prev) => {
      let changed = false;
      const merged = new Set(prev);
      for (const k of next) {
        if (!merged.has(k)) {
          merged.add(k);
          changed = true;
        }
      }
      return changed ? merged : prev;
    });
  };

  // Reset the grown-only seen set once no steers are active, so it can't
  // accumulate across a whole session.
  useEffect(() => {
    if (!hasActiveSteers) setSeenKeys((prev) => (prev.size > 0 ? new Set() : prev));
  }, [hasActiveSteers]);

  useEffect(() => {
    if (!enabled || !hasActiveSteers) return;
    void refresh.current().catch(() => {});
    const id = window.setInterval(() => {
      void refresh.current().catch(() => {});
    }, 1200);
    return () => window.clearInterval(id);
  }, [enabled, hasActiveSteers]);

  // Stable identity so consumers' useCallbacks don't churn every render.
  const stableRefresh = useCallback(() => refresh.current(), []);
  return { pendingKeys, seenKeys, refresh: stableRefresh };
}
