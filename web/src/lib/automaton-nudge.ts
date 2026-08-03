export const AUTOMATON_NUDGE_KEY = "nadi.onboarding.automatonNudge";

/**
 * The prompt seeded into the composer after onboarding. It is tailored to
 * whether a calendar tool actually resolved during setup — Composio finishing
 * OAuth only means the integration platform itself is authorized; the user
 * still connects individual accounts (Gmail, Calendar, Drive) inside it
 * separately, and can finish the wizard with Composio authorized and no
 * calendar attached at all. A briefing that promises calendar data in that
 * case is a broken promise the agent has to apologize for on its first reply.
 */
export function automatonNudgePrompt(input: { calendarConnected: boolean }): string {
  return input.calendarConnected
    ? "Every weekday at 8am, send me a short briefing: my calendar for the day and anything I should know."
    : "Every weekday at 8am, ask me what my top three priorities are for the day.";
}

/**
 * Loose, anchored substring match against "calendar". Vendor tool ids carry a
 * service prefix (`GOOGLECALENDAR_FIND_EVENT`, `calendar_list_events`), so an
 * exact-name allowlist would miss real tools. The failure direction is what
 * matters: a missed match only costs the safe, service-agnostic prompt, while
 * a false match promises calendar data that may not exist — so this stays
 * loose-but-anchored on the word itself rather than enumerating vendor ids.
 */
export function hasCalendarTool(toolNames: readonly string[]): boolean {
  return toolNames.some((name) => name.toLowerCase().includes("calendar"));
}

type NudgeStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** One-shot: armed when the wizard finishes, consumed by the next new chat. */
export function armAutomatonNudge(
  storage: NudgeStorage,
  input: { calendarConnected: boolean },
): void {
  storage.setItem(AUTOMATON_NUDGE_KEY, automatonNudgePrompt(input));
}

export function takeAutomatonNudge(storage: NudgeStorage): string | null {
  const stored = storage.getItem(AUTOMATON_NUDGE_KEY);
  if (stored === null) return null;
  storage.removeItem(AUTOMATON_NUDGE_KEY);
  return stored.trim().length > 0 ? stored : null;
}

/**
 * Reads without consuming. Arming and *showing* the nudge are separated by a
 * screen that may never mount — the new-chat view waits on a thread fetch, and
 * a user who drops offline in the seconds after finishing setup gets an error
 * screen instead. Consuming at that point would lose the nudge for good, so the
 * read is a peek and the clear happens where it is actually rendered.
 */
export function peekAutomatonNudge(storage: NudgeStorage): string | null {
  const stored = storage.getItem(AUTOMATON_NUDGE_KEY);
  if (stored === null) return null;
  return stored.trim().length > 0 ? stored : null;
}
