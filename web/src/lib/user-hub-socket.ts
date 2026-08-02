import { WebSocket as ReconnectingWebSocket } from "partysocket";

export function liveUrl(origin: string): string {
  return `${origin.replace(/^http/, "ws")}/live`;
}

/**
 * Open a reconnecting WebSocket to the user-scope live hub. Same-origin by
 * default so the Better Auth session cookie is sent on the upgrade. Returns the
 * socket so the caller can pass it to useAgentConnectionRecovery and close it on
 * unmount.
 */
export function openUserHubSocket(
  onMessage: (raw: string) => void,
  origin: string = window.location.origin,
): ReconnectingWebSocket {
  const socket = new ReconnectingWebSocket(liveUrl(origin));
  socket.addEventListener("message", (event) => {
    if (typeof event.data === "string") onMessage(event.data);
  });
  return socket;
}

/**
 * `visible` drives unread state (is this thread on screen), `active` drives push
 * suppression (is a human actually here). They are separate on purpose — see
 * src/agent/user-presence.ts.
 */
export function setUserHubPresence(
  socket: Pick<WebSocket, "readyState" | "send"> | null,
  presence: { activeThreadId: string | null; visible: boolean; active?: boolean },
): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: "presence", ...presence }));
}
