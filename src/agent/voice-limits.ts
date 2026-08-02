/**
 * Absolute per-call ceiling, enforced server-side. The browser already ends a
 * dictation at 5s of silence or 30s of speech, but the browser is the thing that
 * can wedge — or be forged — and the transcriber bills every chunk it is sent,
 * silence included (the client streams unconditionally: voice-client.js:645-652).
 * So the agent hangs up on any call that has outlived every legitimate dictation
 * rather than trusting the tab to do it.
 *
 * Comfortably above the client's worst legitimate case (idle 5s + speech 30s).
 */
export const VOICE_CALL_CEILING_MS = 120_000;
