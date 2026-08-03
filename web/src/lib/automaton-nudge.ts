export const AUTOMATON_NUDGE_KEY = "nadi.onboarding.automatonNudge";

/**
 * The prompt seeded into the composer after onboarding. It is tailored to what
 * the user actually connected: a briefing that asks for calendar data is a
 * broken promise if Composio was skipped, and the agent would have to say so on
 * the very first message.
 */
export function automatonNudgePrompt(input: { composioConnected: boolean }): string {
  return input.composioConnected
    ? "Every weekday at 8am, send me a short briefing: my calendar for the day and anything I should know."
    : "Every weekday at 8am, ask me what my top three priorities are for the day.";
}

type NudgeStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** One-shot: armed when the wizard finishes, consumed by the next new chat. */
export function armAutomatonNudge(
  storage: NudgeStorage,
  input: { composioConnected: boolean },
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
