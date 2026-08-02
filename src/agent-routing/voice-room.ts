/**
 * `useVoiceInput()` builds its own WebSocket path via PartySocket. The
 * `@cloudflare/voice` client hardcodes `prefix: "agents"`
 * (node_modules/@cloudflare/voice/dist/voice-client.js:98) — it is not
 * PartySocket's default "parties" prefix — so the room lands under
 * `/agents/voice-agent/<room>` and lets the *client* pick the room. We never
 * trust it: the room is replaced with the authenticated user id, so a client
 * can only ever reach its own VoiceAgent. Same guarantee as /live's
 * idFromName(user), expressed as a rewrite because the SDK client owns the URL.
 */
export function rewriteVoiceRoom(url: URL, userId: string): URL {
  const rewritten = new URL(url);
  rewritten.pathname = `/agents/voice-agent/${encodeURIComponent(userId)}`;
  return rewritten;
}

export const VOICE_PARTY_PREFIX = "/agents/voice-agent/";
