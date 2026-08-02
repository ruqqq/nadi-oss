import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import type { UserEvent } from "./user-events";
import {
  PRESENCE_FRESHNESS_MS,
  type PresenceAttachment,
  hasFreshVisiblePresence,
  hasFreshVisibleThreadPresence,
} from "./user-presence";

function parsePresenceMessage(raw: string): PresenceAttachment | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  if ((value as { type?: unknown }).type !== "presence") return null;
  const activeThreadId = (value as { activeThreadId?: unknown }).activeThreadId;
  const visible = (value as { visible?: unknown }).visible;
  const active = (value as { active?: unknown }).active;
  if (activeThreadId !== null && typeof activeThreadId !== "string") return null;
  if (typeof visible !== "boolean") return null;
  if (active !== undefined && typeof active !== "boolean") return null;
  return {
    activeThreadId,
    visible,
    ...(active === undefined ? {} : { active }),
    updatedAt: Date.now(),
  };
}

/**
 * User-scoped live-update hub. Holds only live WebSocket connections (no stored
 * state). Producers fan out events here via the `publish` RPC; the hub broadcasts
 * them to every connected socket for that user. Best-effort by design — D1 plus
 * the client's resume-refetch are the source of truth.
 */
export class UserHub extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string") return;
    const presence = parsePresenceMessage(message);
    if (!presence) return;
    ws.serializeAttachment(presence);
  }

  async publish(event: UserEvent): Promise<void> {
    const payload = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        // Drop a dead socket silently; delivery is best-effort.
      }
    }
  }

  private presences(): Array<PresenceAttachment | undefined> {
    return this.ctx
      .getWebSockets()
      .map((ws) => ws.deserializeAttachment() as PresenceAttachment | undefined);
  }

  /** Is this user reading `threadId` right now? Drives unread state. */
  hasVisibleThread(threadId: string): boolean {
    return hasFreshVisibleThreadPresence(this.presences(), threadId, Date.now());
  }

  /**
   * Is this user in the app at all right now? Drives push suppression — see
   * user-presence.ts for why this is a separate question from the one above.
   */
  hasVisibleClient(): boolean {
    return hasFreshVisiblePresence(this.presences(), Date.now());
  }

  /**
   * What every live socket is currently claiming, for the token-gated debug
   * route. Read-only, and it answers the question "why did (or didn't) this
   * user get a push" without guessing — which client is holding presence, how
   * old its heartbeat is, and whether anyone is actually at it.
   */
  presenceSnapshot(): {
    now: number;
    socketCount: number;
    hasVisibleClient: boolean;
    clients: Array<{
      activeThreadId: string | null;
      visible: boolean;
      active: boolean | null;
      ageMs: number;
      stale: boolean;
      suppressesPush: boolean;
    }>;
  } {
    const now = Date.now();
    const presences = this.presences();
    return {
      now,
      socketCount: presences.length,
      hasVisibleClient: hasFreshVisiblePresence(presences, now),
      clients: presences.map((presence) => {
        const ageMs = presence ? now - presence.updatedAt : -1;
        const stale = !presence || ageMs > PRESENCE_FRESHNESS_MS;
        return {
          activeThreadId: presence?.activeThreadId ?? null,
          visible: presence?.visible ?? false,
          active: presence?.active ?? null,
          ageMs,
          stale,
          suppressesPush: hasFreshVisiblePresence([presence], now),
        };
      }),
    };
  }
}
