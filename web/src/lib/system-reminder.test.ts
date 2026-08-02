import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import {
  NADI_SYSTEM_REMINDER_KIND,
  isHiddenReminderMessage,
  visibleChatMessages,
} from "./system-reminder";

const msg = (id: string, metadata?: unknown): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text: id }],
  ...(metadata === undefined ? {} : { metadata }),
});

describe("isHiddenReminderMessage", () => {
  it("recognizes a message carrying the system-reminder marker", () => {
    expect(isHiddenReminderMessage(msg("sysrem_1", { nadiKind: NADI_SYSTEM_REMINDER_KIND }))).toBe(
      true,
    );
  });

  it("does not recognize regular user/assistant messages", () => {
    expect(isHiddenReminderMessage(msg("msg_1"))).toBe(false);
    expect(isHiddenReminderMessage(msg("msg_2", { nadiKind: "queued-user-message" }))).toBe(false);
    expect(isHiddenReminderMessage(msg("msg_3", "not-an-object"))).toBe(false);
    expect(isHiddenReminderMessage(msg("msg_4", null))).toBe(false);
  });

  it("does NOT hide a watcher-completion message (it renders as a transcript card)", () => {
    expect(isHiddenReminderMessage(msg("wc_1", { nadiKind: "watcher-completion" }))).toBe(false);
  });
});

describe("visibleChatMessages", () => {
  it("drops system-reminder messages while preserving order and all others", () => {
    const messages: UIMessage[] = [
      msg("msg_1"),
      msg("sysrem_1", { nadiKind: NADI_SYSTEM_REMINDER_KIND }),
      msg("msg_2"),
      msg("sysrem_2", { nadiKind: NADI_SYSTEM_REMINDER_KIND }),
      msg("msg_3"),
    ];

    expect(visibleChatMessages(messages).map((m) => m.id)).toEqual(["msg_1", "msg_2", "msg_3"]);
  });

  it("returns all messages unchanged when none are hidden reminders", () => {
    const messages: UIMessage[] = [msg("msg_1"), msg("msg_2")];
    expect(visibleChatMessages(messages)).toEqual(messages);
  });

  it("returns empty array when all messages are hidden reminders", () => {
    const messages: UIMessage[] = [
      msg("sysrem_1", { nadiKind: NADI_SYSTEM_REMINDER_KIND }),
      msg("sysrem_2", { nadiKind: NADI_SYSTEM_REMINDER_KIND }),
    ];
    expect(visibleChatMessages(messages)).toEqual([]);
  });
});
