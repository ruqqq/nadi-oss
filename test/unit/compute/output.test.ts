import { describe, expect, it } from "vitest";
import {
  grepOutputChunks,
  headTailOutputChunks,
  readOutputChunks,
  tailOutputChunks,
  type OutputChunkView,
} from "../../../src/compute/output";

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

  describe("headTailOutputChunks", () => {
    function manyLines(count: number): OutputChunkView[] {
      const text = Array.from({ length: count }, (_, i) => `line ${i + 1}\n`).join("");
      return [
        {
          stream: "stdout",
          lineStart: 1,
          lineEnd: count,
          byteStart: 0,
          byteEnd: text.length,
          text,
        },
      ];
    }

    it("returns everything with no hidden lines when the stream fits in head+tail", () => {
      const result = headTailOutputChunks(manyLines(10), {
        stream: "stdout",
        headLines: 20,
        tailLines: 20,
      });
      expect(result.hiddenLines).toBe(0);
      expect(result.head).toEqual(Array.from({ length: 10 }, (_, i) => `line ${i + 1}`));
      expect(result.tail).toEqual([]);
    });

    it("reports the exact count of elided lines — never silently drops the middle", () => {
      const result = headTailOutputChunks(manyLines(452), {
        stream: "stdout",
        headLines: 20,
        tailLines: 20,
      });
      expect(result.head).toEqual(Array.from({ length: 20 }, (_, i) => `line ${i + 1}`));
      expect(result.tail).toEqual(Array.from({ length: 20 }, (_, i) => `line ${452 - 20 + i + 1}`));
      // 452 total - 20 head - 20 tail = 412, mirroring the brief's own example.
      expect(result.hiddenLines).toBe(412);
    });

    it("filters by stream", () => {
      const result = headTailOutputChunks(chunks, {
        stream: "stderr",
        headLines: 20,
        tailLines: 20,
      });
      expect(result).toEqual({ head: ["err"], tail: [], hiddenLines: 0 });
    });

    it("boundary: exactly headLines + tailLines fits with no overlap and no hidden lines", () => {
      // 40 lines, headLines:20 + tailLines:20 = 40 exactly — every line must
      // appear ONCE, split cleanly between head and tail, nothing hidden.
      const result = headTailOutputChunks(manyLines(40), {
        stream: "stdout",
        headLines: 20,
        tailLines: 20,
      });
      expect(result.head).toEqual(Array.from({ length: 20 }, (_, i) => `line ${i + 1}`));
      expect(result.tail).toEqual(Array.from({ length: 20 }, (_, i) => `line ${21 + i}`));
      expect(result.hiddenLines).toBe(0);
      expect(result.head.length + result.tail.length).toBe(40);
    });

    it("boundary: one line past headLines + tailLines hides exactly one line", () => {
      // 41 lines: one line over the fits-cleanly boundary must hide exactly
      // one — the off-by-one case right at the edge of the "everything fits"
      // branch.
      const result = headTailOutputChunks(manyLines(41), {
        stream: "stdout",
        headLines: 20,
        tailLines: 20,
      });
      expect(result.head).toEqual(Array.from({ length: 20 }, (_, i) => `line ${i + 1}`));
      expect(result.tail).toEqual(Array.from({ length: 20 }, (_, i) => `line ${22 + i}`));
      expect(result.hiddenLines).toBe(1);
    });
  });
});
