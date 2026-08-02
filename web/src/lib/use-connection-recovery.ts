import { useEffect, useRef } from "react";
import {
  resolveHiddenMs,
  shouldNudgeReconnect,
  shouldRecoverOnResume,
} from "./connection-recovery";

/** The parts of the Agents-SDK client (a partysocket) this module touches. */
interface RecoverableSocket {
  readyState: number;
  reconnect: () => void;
}

// Ignore sub-second visibility flickers; any genuine background exceeds this.
const MIN_HIDDEN_MS = 1_000;
// How often the watchdog checks for a dead-but-unrecovered socket while visible.
const WATCHDOG_INTERVAL_MS = 3_000;

function tabIsVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

function networkIsOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine;
}

/**
 * Fire `onResume(hiddenMs)` when the tab returns to the foreground or the
 * network comes back. `hiddenMs` is how long the tab was hidden — letting the
 * caller skip sub-second flickers — and is `Infinity` for signals that should
 * always recover (bfcache restore, network `online`).
 *
 * Tracks the hide time on both `visibilitychange`→hidden and `pagehide`,
 * because iOS Safari can freeze a tab via `pagehide` without firing
 * `visibilitychange`.
 */
export function useOnResume(onResume: (hiddenMs: number) => void): void {
  const onResumeRef = useRef(onResume);
  onResumeRef.current = onResume;

  useEffect(() => {
    let hiddenAt: number | null = document.visibilityState === "hidden" ? Date.now() : null;

    const markHidden = () => {
      if (hiddenAt === null) hiddenAt = Date.now();
    };
    const fire = (hiddenMs: number) => {
      hiddenAt = null;
      onResumeRef.current(hiddenMs);
    };

    const onVisibility = () => {
      if (document.visibilityState === "hidden") markHidden();
      else fire(resolveHiddenMs(hiddenAt, Date.now(), false));
    };
    const onPageShow = (event: PageTransitionEvent) => {
      fire(resolveHiddenMs(hiddenAt, Date.now(), event.persisted));
    };
    // A network blip can drop the socket without ever hiding the tab, so always
    // treat coming back online as worth recovering.
    const onOnline = () => fire(Number.POSITIVE_INFINITY);

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", markHidden);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", markHidden);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("online", onOnline);
    };
  }, []);
}

/**
 * Self-heal the agent connection across tab background/resume.
 *
 * On a genuine resume it (1) reconnects the socket — replacing a half-open
 * "zombie", restoring liveness, and unsticking a stream that froze mid-turn —
 * and (2) runs `onResume` so the caller can refetch the message history (a
 * reconnect alone does NOT resync; the server never re-pushes history to a
 * reconnecting socket). A foreground watchdog also nudges a CLOSED/CLOSING
 * socket back while the tab stays visible.
 */
export function useAgentConnectionRecovery(
  agent: RecoverableSocket | null | undefined,
  onResume?: (hiddenMs: number) => void,
): void {
  const agentRef = useRef(agent);
  agentRef.current = agent;
  const onResumeRef = useRef(onResume);
  onResumeRef.current = onResume;

  useOnResume((hiddenMs) => {
    if (!shouldRecoverOnResume(hiddenMs, MIN_HIDDEN_MS)) return;
    agentRef.current?.reconnect();
    onResumeRef.current?.(hiddenMs);
  });

  useEffect(() => {
    const id = setInterval(() => {
      const a = agentRef.current;
      if (a && shouldNudgeReconnect(a.readyState, tabIsVisible(), networkIsOnline())) {
        a.reconnect();
      }
    }, WATCHDOG_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);
}
