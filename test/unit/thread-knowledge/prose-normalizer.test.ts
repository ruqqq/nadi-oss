import { describe, expect, it } from "vitest";
import { normalizeProseMessage } from "../../../src/thread-knowledge/prose-normalizer";

describe("normalizeProseMessage", () => {
  it("concatenates visible text and preserves a session timestamp", () => {
    expect(
      normalizeProseMessage({
        id: "msg_1",
        role: "user",
        createdAt: "2026-07-30T10:00:00.000Z",
        parts: [
          { type: "text", text: "first" },
          { type: "tool-exec", toolCallId: "tc_1", state: "output-available", output: "secret" },
          { type: "text", text: "second" },
        ],
      }),
    ).toEqual({
      message: {
        id: "msg_1",
        role: "user",
        text: "first\nsecond",
        createdAt: Date.parse("2026-07-30T10:00:00.000Z"),
      },
      omittedPartCount: 1,
    });
  });

  it("excludes reasoning, tools, files, data, and non-chat roles", () => {
    const parts = [
      { type: "reasoning", text: "private" },
      { type: "file", url: "https://example.com/a" },
      { type: "data-status", data: { value: "hidden" } },
    ];
    expect(normalizeProseMessage({ id: "msg_2", role: "assistant", parts })).toEqual({
      message: null,
      omittedPartCount: 3,
    });
    expect(
      normalizeProseMessage({ id: "msg_3", role: "system", parts: [{ type: "text", text: "x" }] }),
    ).toEqual({ message: null, omittedPartCount: 1 });
  });

  it("excludes compaction overlays and malformed messages", () => {
    expect(
      normalizeProseMessage({
        id: "compaction_123",
        role: "assistant",
        parts: [{ type: "text", text: "summary" }],
      }),
    ).toEqual({ message: null, omittedPartCount: 1 });
    expect(normalizeProseMessage({ role: "user", parts: [] })).toEqual({
      message: null,
      omittedPartCount: 1,
    });
  });
});
