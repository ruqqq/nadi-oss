import type { ModelMessage, UIMessage } from "ai";
import { buildSystemReminderMessage } from "./system-reminder";

/**
 * A model cannot see a clock, and nothing else in the request carries a wall
 * time. The only existing notice is a UTC *date* in the thread-knowledge tool
 * descriptions (see `nowNotice` there), deliberately day-granular because tool
 * definitions lead the request and a ticking value in one would invalidate the
 * whole cacheable prefix on every turn of every thread.
 *
 * So the stamp rides a hidden system-reminder appended once, after the thread's
 * first user message: it costs one message, sits past the cached prefix, and
 * never re-invalidates anything. Being one-shot, it does NOT advance — the body
 * says so plainly, because a frozen timestamp the model reads as "now" is worse
 * than no timestamp at all.
 */
export function buildThreadStartClockReminder(now: Date): UIMessage {
  // Seconds, not milliseconds: the extra precision is noise to a reader that
  // is being told in the next clause not to trust the value as current.
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  return buildSystemReminderMessage(
    `The current date and time is ${stamp} (UTC). This was captured when the ` +
      `conversation started and does not advance as the conversation continues ` +
      `— by later messages it may be hours or days stale. Do not use it as ` +
      `"now" for anything time-sensitive.`,
  );
}

/**
 * True on a thread's first turn: the only turn whose history has no assistant
 * reply yet. This is what delivers the stamp exactly once — from turn two the
 * reply is in the history, and several user messages in a row (a send queued
 * before the turn started) still count as the first turn.
 *
 * An EMPTY history is not a first turn: there is no request to stamp, and a
 * real turn always carries the message that triggered it. Only test probes and
 * degenerate no-message turns get here, and stamping those would put a clock in
 * front of a conversation that has not started.
 *
 * A compaction that archives the transcript can leave a history with no
 * assistant message, which re-stamps the thread. That is the wanted behaviour,
 * not a leak: the surviving context is old and a fresher clock is strictly
 * better than the archived one.
 */
export function isFirstTurn(messages: readonly ModelMessage[]): boolean {
  if (messages.length === 0) return false;
  return !messages.some((message) => message.role === "assistant");
}
