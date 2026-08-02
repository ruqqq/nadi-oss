import { useEffect, useState } from "react";

/** The parts of the Agents-SDK client (a partysocket) this hook observes. */
interface ObservableSocket {
  readyState: number;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
}

/**
 * Track whether the agent's WebSocket is currently open, as reactive state.
 *
 * partysocket exposes `readyState` but doesn't trigger React renders on its own;
 * subscribing to open/close/error lets the UI reflect connect/reconnect
 * transitions (see thread-readiness). Re-syncs on mount and on `agent` identity
 * change so a fresh socket starts from its real state.
 */
export function useSocketConnected(agent: ObservableSocket | null | undefined): boolean {
  const [connected, setConnected] = useState(() => agent?.readyState === WebSocket.OPEN);

  useEffect(() => {
    if (!agent) {
      setConnected(false);
      return;
    }
    const sync = () => setConnected(agent.readyState === WebSocket.OPEN);
    sync();
    agent.addEventListener("open", sync);
    agent.addEventListener("close", sync);
    agent.addEventListener("error", sync);
    return () => {
      agent.removeEventListener("open", sync);
      agent.removeEventListener("close", sync);
      agent.removeEventListener("error", sync);
    };
  }, [agent]);

  return connected;
}
