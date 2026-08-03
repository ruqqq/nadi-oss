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
 * Read-shaped tokens a calendar tool's name needs to carry before it counts.
 * Deliberately just the unambiguous verbs — "event" is left out on purpose:
 * it is a noun that shows up in write tools too (`CREATE_EVENT`,
 * `DELETE_EVENT`), so it does not discriminate read from write and would
 * reintroduce exactly the false-positive this list exists to prevent.
 */
const READ_SHAPED_TOKENS = new Set(["list", "find", "get", "search", "freebusy", "busy"]);

/** Splits a tool name into lowercase words on camelCase, `_`, `-`, and spaces. */
function tokenize(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .split(/[^a-zA-Z0-9]+/)
    .map((token) => token.toLowerCase())
    .filter(Boolean);
}

/**
 * True only for a tool name that is BOTH calendar-named AND read-shaped.
 *
 * `"calendar"` itself is matched as a plain substring, not a whole token —
 * vendor ids concatenate the service name onto the capability with no
 * separator (`GOOGLECALENDAR_FIND_EVENT`), so anchoring on word boundaries
 * would miss real tools. That substring test alone over-matches, though: a
 * server can be scoped to expose only calendar-*named* tools that cannot read
 * anything (`GOOGLECALENDAR_CREATE_EVENT`, `GOOGLECALENDAR_QUICK_ADD`,
 * `GOOGLECALENDAR_DELETE_EVENT`), or a setup tool whose only job is
 * connecting a calendar the user hasn't connected yet
 * (`connect_calendar_account`). Requiring a read-shaped token too rules both
 * out. The failure direction is still what justifies staying loose on each
 * half rather than enumerating vendor tool ids: a missed match only costs the
 * safe, service-agnostic prompt, while a false match promises data the agent
 * cannot fetch.
 */
export function hasCalendarTool(toolNames: readonly string[]): boolean {
  return toolNames.some((name) => {
    if (!name.toLowerCase().includes("calendar")) return false;
    return tokenize(name).some((token) => READ_SHAPED_TOKENS.has(token));
  });
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
