import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { buildThreadStartClockReminder, isFirstTurn } from "../../../src/agent/thread-start-clock";
import { isSystemReminderMessage } from "../../../src/agent/system-reminder";

function reminderText(now: Date): string {
  const message = buildThreadStartClockReminder(now);
  const part = message.parts[0];
  if (part?.type !== "text") throw new Error("expected a text part");
  return part.text;
}

describe("buildThreadStartClockReminder", () => {
  it("stamps the UTC time to second precision", () => {
    expect(reminderText(new Date("2026-08-13T14:22:05.123Z"))).toContain("2026-08-13T14:22:05Z");
  });

  it("drops the millisecond field the ISO string carries", () => {
    expect(reminderText(new Date("2026-08-13T14:22:05.123Z"))).not.toContain(".123");
  });

  it("says the stamp does not advance, so the model cannot read it as a live clock", () => {
    const text = reminderText(new Date("2026-08-13T14:22:05Z"));
    expect(text).toContain("does not advance");
    expect(text).toContain("time-sensitive");
  });

  it("wraps the body in system-reminder tags", () => {
    const text = reminderText(new Date("2026-08-13T14:22:05Z"));
    expect(text.startsWith("<system-reminder>")).toBe(true);
    expect(text.trimEnd().endsWith("</system-reminder>")).toBe(true);
  });

  it("carries the marker the transcript hides it by", () => {
    expect(isSystemReminderMessage(buildThreadStartClockReminder(new Date()))).toBe(true);
  });

  it("is a user-role message, so the model reads it as injected context", () => {
    expect(buildThreadStartClockReminder(new Date()).role).toBe("user");
  });
});

function user(text: string): ModelMessage {
  return { role: "user", content: text };
}

function assistant(text: string): ModelMessage {
  return { role: "assistant", content: text };
}

describe("isFirstTurn", () => {
  it("is true for a thread whose only message is the opening user message", () => {
    expect(isFirstTurn([user("hello")])).toBe(true);
  });

  it("is true when the opening turn carries several user messages", () => {
    // A queued send lands a second user message before the first turn runs.
    expect(isFirstTurn([user("hello"), user("and one more thing")])).toBe(true);
  });

  it("is false once the assistant has replied", () => {
    expect(isFirstTurn([user("hello"), assistant("hi")])).toBe(false);
  });

  it("is false on turn two, where the persisted stamp is part of the history", () => {
    const history: ModelMessage[] = [
      user("hello"),
      { role: "user", content: "<system-reminder>\nclock\n</system-reminder>" },
      assistant("hi"),
      user("what time is it?"),
    ];
    expect(isFirstTurn(history)).toBe(false);
  });

  it("is true for an empty history rather than throwing", () => {
    expect(isFirstTurn([])).toBe(true);
  });
});
