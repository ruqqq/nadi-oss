import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import { mergeResyncedHistory } from "./history-merge";

function user(id: string, text = "hi"): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] } as UIMessage;
}

function assistant(id: string, text: string, state?: "streaming"): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text, ...(state ? { state } : {}) }],
  } as UIMessage;
}

function ids(messages: UIMessage[]): string[] {
  return messages.map((message) => message.id);
}

describe("mergeResyncedHistory", () => {
  it("keeps a streaming assistant message the server has not persisted", () => {
    // The bug this exists for: mid-turn history stops at the user message.
    const local = [user("u1"), assistant("a1", "Sure, let me"), user("u2"), assistant("a2", "part")];
    const fresh = [user("u1"), assistant("a1", "Sure, let me"), user("u2")];

    expect(ids(mergeResyncedHistory(local, fresh))).toEqual(["u1", "a1", "u2", "a2"]);
  });

  it("drops the local partial once the server holds a settled reply", () => {
    // The turn finished while the tab was hidden. Salvaging would strand a dead
    // partial next to the real answer.
    const local = [user("u1"), assistant("a1", "part", "streaming")];
    const fresh = [user("u1"), assistant("a2", "the complete answer")];

    const merged = mergeResyncedHistory(local, fresh);
    expect(ids(merged)).toEqual(["u1", "a2"]);
    expect(merged).toBe(fresh);
  });

  it("salvages nothing when history shares no id with the server (compaction)", () => {
    // The server rewrote history; "after the last shared message" is meaningless.
    const local = [user("u1"), assistant("a1", "old"), assistant("a2", "streaming")];
    const fresh = [user("c1", "[compacted summary]"), user("u9")];

    expect(ids(mergeResyncedHistory(local, fresh))).toEqual(["c1", "u9"]);
  });

  it("takes the server's copy of a message present on both sides", () => {
    const local = [user("u1"), assistant("a1", "half")];
    const fresh = [user("u1"), assistant("a1", "half, then the rest")];

    const merged = mergeResyncedHistory(local, fresh);
    expect(ids(merged)).toEqual(["u1", "a1"]);
    expect(merged[1]).toBe(fresh[1]);
  });

  it("does not salvage a local-only user message", () => {
    // Owned by the optimistic-first-message path, which would fight us for it.
    const local = [user("u1"), assistant("a1", "done"), user("u2", "queued locally")];
    const fresh = [user("u1"), assistant("a1", "done")];

    expect(ids(mergeResyncedHistory(local, fresh))).toEqual(["u1", "a1"]);
  });

  it("returns the server transcript when there is nothing local", () => {
    const fresh = [user("u1"), assistant("a1", "hello")];
    expect(mergeResyncedHistory([], fresh)).toBe(fresh);
  });
});
