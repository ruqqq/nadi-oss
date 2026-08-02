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
  /**
   * The pending-reply window ran out with no stream to show for it, so stop
   * promising one. Restarted on every socket open — see ThreadChat.
   */
  pendingReplyExpired: boolean;
  offline: boolean;
  /** Is a turn live client-side? (`isStreaming || status === "submitted"`) */
  streamActive: boolean;
  /** Does the loaded history stop on a user message? (`awaitsAssistantReply`) */
  awaitingReply: boolean;
}): ThreadReadiness {
  const {
    socketConnected,
    everConnected,
    historyReloading,
    pendingReplyExpired,
    offline,
    streamActive,
    awaitingReply,
  } = input;

  // Held until the reply itself shows up, NOT until the socket opens. The
  // socket opens a few hundred ms before the SDK's resume handshake replays any
  // chunks, and releasing on `everConnected` left that window with no bubble and
  // no dots — the placeholder went away before its replacement arrived.
  //
  // Every clause earns its place —
  //  - offline: no socket is coming, so no reply is coming.
  //  - streamActive: the stream took over; isStreaming drives the dots from here.
  //  - pendingReplyExpired: the valve. Without it a thread whose turn died
  //    mid-flight would promise a reply forever, since nothing else in this
  //    predicate ever becomes false on its own.
  //  - awaitingReply: the transcript stops on a user message. An empty thread
  //    falls out for free — it has no last message to be a user message.
  const showPendingReply = !offline && !streamActive && !pendingReplyExpired && awaitingReply;

  const sendBlocked = offline || !socketConnected || historyReloading;

  // Offline outranks the socket reasons: "Connecting…" is a lie when we know
  // the network is down.
  let reason: ThreadReadinessReason = null;
  if (offline) reason = "offline";
  else if (!socketConnected) reason = everConnected ? "reconnecting" : "connecting";
  else if (historyReloading) reason = "reloading";

  return { showPendingReply, sendBlocked, reason };
}
