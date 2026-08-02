export type ThreadReadinessReason =
  | "offline"
  | "connecting"
  | "reconnecting"
  | "reloading"
  | null;

export interface ThreadReadiness {
  /** Forewarn that a reply is inbound: history stops mid-turn and the socket
   *  that will deliver it hasn't opened yet. Drives the typing indicator. */
  showPendingReply: boolean;
  /** Block the composer's action path (send / queue / steer / stop). */
  sendBlocked: boolean;
  /** Why the thread isn't fully interactive, for the composer status hint. */
  reason: ThreadReadinessReason;
}

/**
 * Derive the thread's UI readiness from connection + history-reload state.
 *
 * Pure so it's unit-testable; the reactive inputs (socket open, first-connect
 * latch, ~4s connect timeout, history-reload flag) are wired in ThreadChat.
 *
 * The transcript itself is NOT gated on the socket: history arrives over plain
 * HTTP and paints as soon as it resolves. Waiting for both made every thread
 * open feel as slow as its slowest half, and it was never what kept the UI
 * honest — `sendBlocked` is, and it stands on its own.
 */
export function computeThreadReadiness(input: {
  socketConnected: boolean;
  everConnected: boolean;
  historyReloading: boolean;
  connectTimedOut: boolean;
  offline: boolean;
  /** How many messages the loaded history holds. */
  messageCount: number;
  /** Does that history end on a finished turn? (`isConversationComplete`) */
  conversationComplete: boolean;
}): ThreadReadiness {
  const {
    socketConnected,
    everConnected,
    historyReloading,
    connectTimedOut,
    offline,
    messageCount,
    conversationComplete,
  } = input;

  // Only before the first connect: after it, isStreaming drives the indicator.
  // Every clause earns its place —
  //  - offline: no socket is coming, so no reply is coming.
  //  - connectTimedOut: the same 4s valve that used to release the full
  //    skeleton, so a socket that never opens can't twitch the dots forever.
  //  - messageCount: isConversationComplete([]) is FALSE, so a brand-new empty
  //    thread reads as "mid-turn" and would promise a reply nobody sent.
  const showPendingReply =
    !offline && !everConnected && !connectTimedOut && messageCount > 0 && !conversationComplete;

  const sendBlocked = offline || !socketConnected || historyReloading;

  // Offline outranks the socket reasons: "Connecting…" is a lie when we know
  // the network is down.
  let reason: ThreadReadinessReason = null;
  if (offline) reason = "offline";
  else if (!socketConnected) reason = everConnected ? "reconnecting" : "connecting";
  else if (historyReloading) reason = "reloading";

  return { showPendingReply, sendBlocked, reason };
}
