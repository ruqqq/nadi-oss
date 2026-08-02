import { describe, expect, it } from "vitest";
import { grepOutputChunks, readOutputChunks, tailOutputChunks } from "../../../src/compute/output";

const chunks = [
  {
    stream: "stdout" as const,
    lineStart: 1,
    lineEnd: 2,
    byteStart: 0,
    byteEnd: 12,
    text: "one\ntwo\n",
  },
  {
    stream: "stdout" as const,
    lineStart: 3,
    lineEnd: 4,
    byteStart: 12,
    byteEnd: 26,
    text: "three\nfour\n",
  },
  { stream: "stderr" as const, lineStart: 1, lineEnd: 1, byteStart: 0, byteEnd: 6, text: "err\n" },
];

describe("sandbox output helpers", () => {
  it("tails bounded lines", () => {
    expect(
      tailOutputChunks(chunks, { stream: "stdout", maxLines: 2, maxBytes: 100 }),
    ).toMatchObject({
      text: "three\nfour\n",
      limited: false,
    });
  });

  it("greps with hard match caps", () => {
    const result = grepOutputChunks(chunks, {
      pattern: "o",
      stream: "stdout",
      caseSensitive: true,
      contextLines: 0,
      maxMatches: 1,
      maxReturnedLines: 10,
      maxBytes: 100,
    });
    expect(result.matches).toHaveLength(1);
    expect(result.limited).toBe(true);
    expect(result.limitReason).toBe("max_matches");
  });

  it("reads line ranges", () => {
    expect(
      readOutputChunks(chunks, { stream: "stdout", startLine: 2, endLine: 3, maxBytes: 100 }),
    ).toMatchObject({
      text: "two\nthree\n",
      limited: false,
    });
  });

  it("reads a byte range from startByte across chunks", () => {
    // Full stdout stream is "one\ntwo\nthree\nfour\n" (18 bytes). Byte offset 4
    // starts at "two\n" and spans into the second chunk.
    expect(
      readOutputChunks(chunks, { stream: "stdout", startByte: 4, maxBytes: 100 }),
    ).toMatchObject({
      text: "two\nthree\nfour\n",
      limited: false,
    });
  });

  it("bounds a byte-range read by maxBytes", () => {
    expect(readOutputChunks(chunks, { stream: "stdout", startByte: 0, maxBytes: 3 })).toMatchObject(
      {
        text: "one",
        limited: true,
        limitReason: "max_bytes",
      },
    );
  });

  it("enforces readMaxLines on line reads", () => {
    const result = readOutputChunks(chunks, { stream: "stdout", maxLines: 2, maxBytes: 1000 });
    expect(result).toMatchObject({
      text: "one\ntwo\n",
      limited: true,
      limitReason: "max_lines",
    });
  });

  it("rejects a pathologically long grep pattern", () => {
    expect(() =>
      grepOutputChunks(chunks, {
        pattern: "a".repeat(500),
        stream: "stdout",
        caseSensitive: false,
        contextLines: 0,
        maxMatches: 10,
        maxReturnedLines: 100,
        maxBytes: 1000,
      }),
    ).toThrow("sandbox_grep_pattern_too_long");
  });
});
