import { describe, expect, it } from "vitest";
import { boundOutput, boundText, boundTranscript } from "../../../src/agent/transcript-bounding";

const OPTS = {
  partHeadChars: 10,
  partTailChars: 5,
  minTailMessages: 2,
  maxRetainedMessageChars: 60,
  headMaxChars: 40,
};

const toolMsg = (id: string, output: string) => ({
  id,
  role: "assistant" as const,
  parts: [
    { type: "tool-exec", toolCallId: id, state: "output-available", input: {}, output } as {
      type: string;
      toolCallId: string;
      state: string;
      input: unknown;
      output: unknown;
    },
  ],
});

const outputOf = (message: { parts: readonly { output?: unknown }[] }): unknown =>
  message.parts[0]?.output;

describe("boundText", () => {
  it("keeps both ends and reports what it dropped", () => {
    const out = boundText(`0123456789${"M".repeat(200)}FGHIJ`, 10, 5);
    expect(out.startsWith("0123456789")).toBe(true);
    expect(out.endsWith("FGHIJ")).toBe(true);
    expect(out).toContain("truncated 200 chars");
  });

  // Bounding must never GROW its input: below head + tail + marker there is
  // nothing to win, so the text is returned untouched.
  it("leaves text alone when the marker would cost more than it saves", () => {
    const short = `0123456789${"M".repeat(5)}FGHIJ`;
    expect(boundText(short, 10, 5)).toBe(short);
  });

  it("returns short text unchanged", () => {
    expect(boundText("short", 10, 5)).toBe("short");
  });

  it("is idempotent — bounding a bounded string changes nothing", () => {
    const once = boundText(`0123456789${"M".repeat(200)}FGHIJ`, 10, 5);
    expect(boundText(once, 10, 5)).toBe(once);
  });
});

describe("boundOutput", () => {
  it("leaves a small object's shape intact", () => {
    const value = { ok: true };
    expect(boundOutput(value, 10, 5)).toBe(value);
  });

  it("renders an oversized object as a bounded string", () => {
    const value = { blob: "x".repeat(500) };
    const out = boundOutput(value, 10, 5);
    expect(typeof out).toBe("string");
    expect(out as string).toContain("truncated");
  });
});

describe("boundTranscript", () => {
  it("bounds parts outside the retained tail", () => {
    const messages = [
      toolMsg("a", `0123456789${"M".repeat(200)}FGHIJ`),
      toolMsg("b", "short"),
      toolMsg("c", "short"),
    ];
    const out = boundTranscript(messages, OPTS);
    expect(outputOf(out[0]!)).toContain("truncated");
  });

  // The bug this whole plan exists for: recency was the criterion, so on a
  // short thread nothing was bounded at all.
  it("bounds a huge FIRST message even when the thread is shorter than any keepRecent window", () => {
    const messages = [toolMsg("big", "z".repeat(10_000)), toolMsg("b", "s"), toolMsg("c", "s")];
    const out = boundTranscript(messages, OPTS);
    expect((outputOf(out[0]!) as string).length).toBeLessThan(100);
  });

  it("leaves small retained-tail messages untouched", () => {
    const messages = [toolMsg("a", "s"), toolMsg("b", "s"), toolMsg("c", "s")];
    const out = boundTranscript(messages, OPTS);
    expect(out[1]).toBe(messages[1]);
    expect(out[2]).toBe(messages[2]);
  });

  // Discriminating case for the exemption itself: this part is over the PART
  // threshold (so it would be bounded anywhere else) but the message is under
  // the per-message ceiling, so the retained tail must keep it verbatim. The
  // "small messages untouched" test above cannot catch a broken exemption —
  // small messages come back identical either way.
  it("keeps a tail part that exceeds the part threshold but fits the message ceiling", () => {
    const body = "Q".repeat(60);
    const messages = [toolMsg("a", "s"), toolMsg("b", body), toolMsg("c", "s")];
    const out = boundTranscript(messages, { ...OPTS, maxRetainedMessageChars: 60 });
    expect(outputOf(out[1]!)).toBe(body);
    expect(out[1]).toBe(messages[1]);
  });

  // Without this the tail is unbounded for exactly the reason the head was:
  // the ceiling is per MESSAGE, the cost is per PART.
  it("bounds a retained-tail message that exceeds the per-message ceiling", () => {
    const messages = [toolMsg("a", "s"), toolMsg("b", "y".repeat(500)), toolMsg("c", "s")];
    const out = boundTranscript(messages, OPTS);
    expect(outputOf(out[1]!)).toContain("truncated");
  });

  // The head is the one message compaction may never summarize, so it is the
  // one message whose total size must be capped outright — part bounding alone
  // leaves it unbounded once it has enough parts.
  it("caps the first message by dropping trailing parts when it exceeds headMaxChars", () => {
    const wide = {
      id: "u0",
      role: "user" as const,
      parts: Array.from({ length: 12 }, (_, i) => ({ type: "text", text: `part-${i}-xxxxx` })),
    };
    const out = boundTranscript([wide, toolMsg("b", "s"), toolMsg("c", "s")], OPTS);
    const chars = out[0]!.parts.reduce(
      (n: number, p) => n + ((p as { text?: string }).text?.length ?? 0),
      0,
    );
    expect(chars).toBeLessThanOrEqual(OPTS.headMaxChars);
    expect(out[0]!.parts.length).toBeLessThan(wide.parts.length);
  });

  it("returns the same array instance when nothing needed bounding", () => {
    const messages = [toolMsg("a", "s"), toolMsg("b", "s")];
    expect(boundTranscript(messages, OPTS)).toBe(messages);
  });
});
