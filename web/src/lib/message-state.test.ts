import { describe, expect, it, test } from "vitest";
import type { UIMessage } from "ai";
import {
  assistantHasPainted,
  awaitsAssistantReply,
  isConversationComplete,
  withRenderableContent,
} from "./message-state";

function text(text: string, state = "done") {
  return { type: "text", text, state };
}
function reasoning(text: string, state = "done") {
  return { type: "reasoning", text, state };
}
function toolCall(toolCallId: string, state: string) {
  return { type: "tool-call", toolCallId, state, input: {} };
}
function assistant(id: string, parts: unknown[]): UIMessage {
  return { id, role: "assistant", parts } as unknown as UIMessage;
}
function user(id: string, parts: unknown[]): UIMessage {
  return { id, role: "user", parts } as unknown as UIMessage;
}

describe("isConversationComplete", () => {
  it("returns true for a finished conversation", () => {
    const msgs = [assistant("m1", [text("Hello"), reasoning("done")])];
    expect(isConversationComplete(msgs)).toBe(true);
  });

  it("returns false when last assistant has a streaming text part", () => {
    const msgs = [assistant("m1", [text("incomplete", "streaming")])];
    expect(isConversationComplete(msgs)).toBe(false);
  });

  it("returns false when last assistant has a streaming reasoning part", () => {
    const msgs = [assistant("m1", [reasoning("thinking...", "streaming")])];
    expect(isConversationComplete(msgs)).toBe(false);
  });

  it("returns false when only user messages exist (no assistant)", () => {
    const msgs = [user("m1", [text("hello")])];
    expect(isConversationComplete(msgs)).toBe(false);
  });

  it("returns true when streaming parts are in earlier messages but latest is done", () => {
    const msgs = [
      assistant("m1", [text("old", "done")]),
      user("m2", [text("ping")]),
      assistant("m3", [text("latest", "done")]),
    ];
    expect(isConversationComplete(msgs)).toBe(true);
  });

  it("returns false when a tool call has input-streaming state", () => {
    const msgs = [assistant("m1", [toolCall("tc1", "input-streaming")])];
    expect(isConversationComplete(msgs)).toBe(false);
  });

  it("returns true when a tool call has output-available state", () => {
    const msgs = [assistant("m1", [toolCall("tc1", "output-available")])];
    expect(isConversationComplete(msgs)).toBe(true);
  });

  it("returns false when any message has a streaming text part", () => {
    const msgs = [
      assistant("m1", [text("Hello", "done")]),
      assistant("m2", [text("Still going", "streaming")]),
    ];
    expect(isConversationComplete(msgs)).toBe(false);
  });

  it("handles empty message list", () => {
    expect(isConversationComplete([])).toBe(false);
  });

  it("handles messages with null/undefined parts", () => {
    const msgs = [{ id: "m1", role: "assistant", parts: undefined }] as unknown as UIMessage[];
    expect(isConversationComplete(msgs)).toBe(true);
  });

  it("returns true when message has parts with no state (legacy format)", () => {
    const msgs = [
      assistant("m1", [{ type: "text", text: "hello" }]),
    ];
    expect(isConversationComplete(msgs)).toBe(true);
  });
});

describe("awaitsAssistantReply", () => {
  const user = (id: string) => ({ id, role: "user", parts: [] }) as unknown as UIMessage;
  const assistant = (id: string) => ({ id, role: "assistant", parts: [] }) as unknown as UIMessage;

  test("transcript stopping on a user message is awaiting a reply", () => {
    expect(awaitsAssistantReply([user("u1")])).toBe(true);
  });

  // THE BUG THIS EXISTS FOR. `!isConversationComplete` answers FALSE here — it
  // means "nothing is streaming", so every thread past its first turn looked
  // finished and never showed the pending-reply indicator.
  test("a completed earlier turn does not make a mid-turn transcript look done", () => {
    const messages = [user("u1"), assistant("a1"), user("u2")];
    expect(awaitsAssistantReply(messages)).toBe(true);
    expect(isConversationComplete(messages)).toBe(true);
  });

  test("transcript ending on an assistant reply awaits nothing", () => {
    expect(awaitsAssistantReply([user("u1"), assistant("a1")])).toBe(false);
  });

  test("empty transcript awaits nothing", () => {
    expect(awaitsAssistantReply([])).toBe(false);
  });
});

describe("assistantHasPainted", () => {
  const user = (id: string) => ({ id, role: "user", parts: [] }) as unknown as UIMessage;
  const assistant = (id: string) => ({ id, role: "assistant", parts: [] }) as unknown as UIMessage;

  test("a trailing assistant message is something to trail", () => {
    expect(assistantHasPainted([user("u1"), assistant("a1")])).toBe(true);
  });

  test("a transcript still owing a reply has painted nothing", () => {
    expect(assistantHasPainted([user("u1")])).toBe(false);
  });

  // Not the negation of awaitsAssistantReply: both answer false here, and both
  // are right. Nothing is owed, and there is nothing to trail either.
  test("an empty transcript has painted nothing", () => {
    expect(assistantHasPainted([])).toBe(false);
    expect(awaitsAssistantReply([])).toBe(false);
  });
});

describe("withRenderableContent", () => {
  const msg = (role: string, parts: unknown[]) => ({ id: role + parts.length, role, parts }) as unknown as UIMessage;

  // THE BUG THIS EXISTS FOR. The SDK inserts a bare assistant message when a
  // stream opens. It paints nothing, but as a child of a gap-8 flex column it
  // still contributes 32px — so the typing dots dropped 32px the instant a turn
  // started and rose again on the first token.
  test("drops the empty assistant placeholder a stream opens with", () => {
    const messages = [msg("user", [{ type: "text", text: "hi" }]), msg("assistant", [])];
    expect(withRenderableContent(messages).map((m) => m.role)).toEqual(["user"]);
  });

  test("keeps an assistant message the moment it has text", () => {
    const messages = [msg("assistant", [{ type: "text", text: "T" }])];
    expect(withRenderableContent(messages)).toHaveLength(1);
  });

  test("keeps a tool-only assistant message, which paints a tool row", () => {
    const messages = [msg("assistant", [{ type: "tool-read_file", state: "input-available" }])];
    expect(withRenderableContent(messages)).toHaveLength(1);
  });

  test("drops an assistant message whose only text is whitespace", () => {
    expect(withRenderableContent([msg("assistant", [{ type: "text", text: "   " }])])).toHaveLength(0);
  });

  // Never filter the user's side: an empty-looking user message would be an
  // attachment-only one, and those carry file parts.
  test("leaves user messages alone", () => {
    expect(withRenderableContent([msg("user", [])])).toHaveLength(1);
  });
});
