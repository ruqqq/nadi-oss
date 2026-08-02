import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  buildSystemReminderMessage,
  buildWatcherCompletionMessage,
  isSystemReminderMessage,
  isWatcherCompletionMessage,
  NADI_SYSTEM_REMINDER_KIND,
  NADI_WATCHER_COMPLETION_KIND,
  type WatcherCompletionInfo,
} from "../../../src/agent/system-reminder";

describe("buildSystemReminderMessage", () => {
  it("builds a user message wrapping the body in <system-reminder> tags", () => {
    const message = buildSystemReminderMessage("X");

    expect(message.role).toBe("user");
    expect(typeof message.id).toBe("string");
    expect(message.id.length).toBeGreaterThan(0);
    expect(message.parts).toEqual([
      { type: "text", text: "<system-reminder>\nX\n</system-reminder>" },
    ]);
    expect(message.metadata).toEqual({ nadiKind: NADI_SYSTEM_REMINDER_KIND });
  });

  it("prefixes the generated id with sysrem_", () => {
    const message = buildSystemReminderMessage("hello");
    expect(message.id.startsWith("sysrem_")).toBe(true);
  });
});

describe("isSystemReminderMessage", () => {
  it("returns true for a built system-reminder message", () => {
    const message = buildSystemReminderMessage("hello");
    expect(isSystemReminderMessage(message)).toBe(true);
  });

  it("returns false for a plain user message", () => {
    const message: UIMessage = {
      id: "msg-1",
      role: "user",
      parts: [{ type: "text", text: "hello" }],
    };
    expect(isSystemReminderMessage(message)).toBe(false);
  });

  it("returns false for a user message lacking the metadata kind", () => {
    const message: UIMessage = {
      id: "msg-2",
      role: "user",
      parts: [{ type: "text", text: "<system-reminder>\nhello\n</system-reminder>" }],
      metadata: { nadiKind: "something-else" },
    };
    expect(isSystemReminderMessage(message)).toBe(false);
  });

  it("returns false for a watcher-completion message (distinct kind)", () => {
    const message = buildWatcherCompletionMessage("done", {
      title: "build",
      command: "pnpm build",
      processId: "proc_1",
      outcome: "exited",
      exitCode: 0,
    });
    expect(isSystemReminderMessage(message)).toBe(false);
  });
});

const exitedInfo: WatcherCompletionInfo = {
  title: "build",
  command: "pnpm build",
  processId: "proc_1",
  outcome: "exited",
  exitCode: 0,
  outputTail: "done\n",
};

describe("buildWatcherCompletionMessage", () => {
  it("wraps the body in <system-reminder> tags so the model still reads it", () => {
    const message = buildWatcherCompletionMessage("proc exited", exitedInfo);

    expect(message.role).toBe("user");
    expect(message.id.startsWith("sysrem_")).toBe(true);
    expect(message.parts).toEqual([
      { type: "text", text: "<system-reminder>\nproc exited\n</system-reminder>" },
    ]);
  });

  it("tags a distinct watcher-completion kind carrying the structured facts", () => {
    const message = buildWatcherCompletionMessage("proc exited", exitedInfo);
    expect(message.metadata).toEqual({
      nadiKind: NADI_WATCHER_COMPLETION_KIND,
      watcher: exitedInfo,
    });
    expect(NADI_WATCHER_COMPLETION_KIND).not.toBe(NADI_SYSTEM_REMINDER_KIND);
  });
});

describe("isWatcherCompletionMessage", () => {
  it("returns true for a built watcher-completion message", () => {
    expect(isWatcherCompletionMessage(buildWatcherCompletionMessage("x", exitedInfo))).toBe(true);
  });

  it("returns false for a plain system-reminder message", () => {
    expect(isWatcherCompletionMessage(buildSystemReminderMessage("x"))).toBe(false);
  });
});
