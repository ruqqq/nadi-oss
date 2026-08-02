/**
 * Pure language resolution for dictation. Kept out of voice-agent.ts so unit
 * tests can import it without pulling in `agents` (which needs cloudflare:workers).
 */

/** Falls back to English when the user has no stored preference. */
export function resolveVoiceLanguage(raw: string | undefined): string {
  return raw && raw.length > 0 ? raw : "en";
}
