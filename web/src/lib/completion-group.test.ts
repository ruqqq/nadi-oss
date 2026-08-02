import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { groupChatMessages, isCompletionMessage } from "./completion-group";

const watcher = (id: string): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text: "<system-reminder>\nx\n</system-reminder>" }],
  metadata: {
    nadiKind: "watcher-completion",
    watcher: { title: "t", command: "c", outcome: "exited", exitCode: 0 },
  },
});
const subagent = (id: string): UIMessage => ({
  id,
  role: "user",
  parts: [
    {
      type: "text",
      text: `<system-reminder>\nSubagent "probe" finished: completed. [${id}]\ndone\n</system-reminder>`,
    },
  ],
});
const user = (id: string): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text: "hi" }],
});
const assistant = (id: string): UIMessage => ({
  id,
  role: "assistant",
  parts: [{ type: "text", text: "reply" }],
});

const shape = (m: ReturnType<typeof groupChatMessages>) =>
  m.map((it) =>
    it.kind === "completions" ? `group[${it.run.map((r) => r.id).join(",")}]` : it.message.id,
  );

describe("isCompletionMessage", () => {
  it("recognizes watcher and subagent completions, not plain messages", () => {
    expect(isCompletionMessage(watcher("w1"))).toBe(true);
    expect(isCompletionMessage(subagent("s1"))).toBe(true);
    expect(isCompletionMessage(user("u1"))).toBe(false);
    expect(isCompletionMessage(assistant("a1"))).toBe(false);
  });
});

describe("groupChatMessages", () => {
  it("passes non-completion messages through unchanged", () => {
    expect(shape(groupChatMessages([user("u1"), assistant("a1")]))).toEqual(["u1", "a1"]);
  });

  it("groups a consecutive completion run and renders it AFTER a following assistant", () => {
    const out = groupChatMessages([user("u1"), watcher("w1"), subagent("s1"), assistant("a1")]);
    // response first, then the results group beneath it
    expect(shape(out)).toEqual(["u1", "a1", "group[w1,s1]"]);
  });

  it("renders the group in place when not followed by an assistant", () => {
    expect(shape(groupChatMessages([user("u1"), watcher("w1"), subagent("s1")]))).toEqual([
      "u1",
      "group[w1,s1]",
    ]);
    expect(shape(groupChatMessages([watcher("w1"), user("u2")]))).toEqual(["group[w1]", "u2"]);
  });

  it("handles multiple separate runs", () => {
    const out = groupChatMessages([
      watcher("w1"),
      assistant("a1"),
      subagent("s1"),
      subagent("s2"),
      assistant("a2"),
    ]);
    expect(shape(out)).toEqual(["a1", "group[w1]", "a2", "group[s1,s2]"]);
  });
});
