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
 * Read-shaped VERB tokens a calendar tool's name needs to carry. "event" /
 * "events" deliberately do NOT live here — they're nouns that show up in
 * write tools too (`CREATE_EVENT`, `DELETE_EVENT`), so alone they don't
 * discriminate read from write. `read`/`fetch`/`retrieve`/`view`/`query` are
 * included even though no vendor example has needed them yet: there is no
 * safety cost to a miss, and `read` in particular is the single most natural
 * verb for a read tool to be named after.
 */
const READ_VERB_TOKENS = new Set([
  "list",
  "find",
  "get",
  "search",
  "read",
  "fetch",
  "retrieve",
  "view",
  "query",
]);

/**
 * Nouns meaning the read actually reaches events or availability — not just
 * calendar metadata. Required IN ADDITION to a read verb, which is exactly
 * what "event"/"events" needs to be safe here: `CREATE_EVENT` and
 * `DELETE_EVENT` still fail on the VERB gate, so treating "event" as a noun
 * requirement only doesn't reopen the false positive it caused when it was a
 * sufficient signal on its own.
 *
 * Deliberately excludes "calendars": `GOOGLECALENDAR_LIST_CALENDARS` lists
 * which calendars exist (ids/names), not what's on any of them. That's
 * calendar metadata, same category as `GET_SETTINGS`/`GET_ACL`/`GET_COLORS` —
 * genuinely read-shaped by verb, but no more useful for "my calendar for the
 * day" than those are, so it doesn't earn the noun gate either.
 */
const EVENT_OR_AVAILABILITY_TOKENS = new Set([
  "event",
  "events",
  "slot",
  "slots",
  "busy",
  "freebusy",
  "schedule",
  "agenda",
]);

/** Splits a tool name into lowercase words on camelCase, `_`, `-`, and spaces. */
function tokenize(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .split(/[^a-zA-Z0-9]+/)
    .map((token) => token.toLowerCase())
    .filter(Boolean);
}

/**
 * True only for a tool name that is calendar-named AND read-shaped AND reads
 * events or availability specifically — all three, not any two.
 *
 * `"calendar"` itself is matched as a plain substring, not a whole token —
 * vendor ids concatenate the service name onto the capability with no
 * separator (`GOOGLECALENDAR_FIND_EVENT`), so anchoring on word boundaries
 * would miss real tools. That substring test alone over-matches: a server can
 * be scoped to expose only calendar-*named* tools that cannot read anything
 * (`GOOGLECALENDAR_CREATE_EVENT`, `GOOGLECALENDAR_QUICK_ADD`,
 * `GOOGLECALENDAR_DELETE_EVENT`), or a setup tool whose only job is connecting
 * a calendar the user hasn't connected yet (`connect_calendar_account`).
 * Requiring a read verb rules both out, but a read verb alone still
 * over-matches metadata reads that can't produce a daily briefing
 * (`GOOGLECALENDAR_GET_SETTINGS`, `GET_ACL`, `GET_COLORS` all pass a
 * verb-only gate) — hence the third requirement, an event-or-availability
 * noun. The failure direction is still what justifies staying loose on each
 * half rather than enumerating vendor tool ids: a missed match only costs the
 * safe, service-agnostic prompt, while a false match promises data the agent
 * cannot fetch.
 */
export function hasCalendarTool(toolNames: readonly string[]): boolean {
  return toolNames.some((name) => {
    if (!name.toLowerCase().includes("calendar")) return false;
    const tokens = tokenize(name);
    const hasReadVerb = tokens.some((token) => READ_VERB_TOKENS.has(token));
    const hasEventOrAvailabilityNoun = tokens.some((token) =>
      EVENT_OR_AVAILABILITY_TOKENS.has(token),
    );
    return hasReadVerb && hasEventOrAvailabilityNoun;
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
