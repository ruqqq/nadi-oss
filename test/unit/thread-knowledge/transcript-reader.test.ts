import { describe, expect, it } from "vitest";
import { GREP_MAX_PATTERN_LENGTH } from "../../../src/compute/output";
import {
  THREAD_READ_MAX_MESSAGES,
  THREAD_READ_MAX_TEXT_BYTES,
  THREAD_SOURCE_SCAN_MAX_MESSAGES,
  type RawTranscriptStat,
  type ThreadOrder,
  type TranscriptSource,
} from "../../../src/thread-knowledge/types";
import {
  grepTranscript,
  readTranscriptPage,
} from "../../../src/thread-knowledge/transcript-reader";

type StoredMessage = {
  id: string;
  position: number;
  raw: unknown;
};

class MemoryTranscriptSource implements TranscriptSource {
  readonly listCalls: Array<{ afterPosition?: number; order: ThreadOrder; limit: number }> = [];
  readonly getCalls: string[] = [];
  private readonly messages: StoredMessage[];

  constructor(rawMessages: unknown[]) {
    this.messages = rawMessages.map((raw, index) => {
      const id =
        typeof raw === "object" && raw !== null && typeof (raw as { id?: unknown }).id === "string"
          ? (raw as { id: string }).id
          : `raw:${index}`;
      return { id, position: index, raw };
    });
  }

  async listStats(input: {
    afterPosition?: number;
    order: ThreadOrder;
    limit: number;
  }): Promise<{ stats: RawTranscriptStat[]; nextPosition?: number }> {
    this.listCalls.push(input);
    const ordered = [...this.messages].sort((a, b) =>
      input.order === "chronological" ? a.position - b.position : b.position - a.position,
    );
    const after = input.afterPosition;
    const eligible = ordered.filter((message) => {
      if (after === undefined) return true;
      return input.order === "chronological" ? message.position > after : message.position < after;
    });
    const page = eligible.slice(0, input.limit);
    const stats = page.map((message) => ({
      id: message.id,
      position: message.position,
      bytes: new TextEncoder().encode(JSON.stringify(message.raw)).byteLength,
    }));
    const result: { stats: RawTranscriptStat[]; nextPosition?: number } = { stats };
    const last = page[page.length - 1];
    if (eligible.length > input.limit && last !== undefined) {
      result.nextPosition = last.position;
    }
    return result;
  }

  async getMessage(id: string): Promise<unknown | null> {
    this.getCalls.push(id);
    return this.messages.find((message) => message.id === id)?.raw ?? null;
  }
}

function textMessage(input: {
  id: string;
  role?: "user" | "assistant";
  text: string;
  createdAt?: string | number | null;
  extraParts?: unknown[];
}) {
  return {
    id: input.id,
    role: input.role ?? "user",
    createdAt: input.createdAt,
    parts: [{ type: "text", text: input.text }, ...(input.extraParts ?? [])],
  };
}

describe("readTranscriptPage", () => {
  it("reads chronological and reverse pages using a cursor without fetching skipped rows", async () => {
    const source = new MemoryTranscriptSource([
      textMessage({ id: "m1", text: "one" }),
      textMessage({ id: "m2", role: "assistant", text: "two" }),
      textMessage({ id: "m3", text: "three" }),
    ]);

    const first = await readTranscriptPage(source, {
      threadId: "thr_reader",
      order: "chronological",
      limit: 2,
    });
    expect(first.messages.map((message) => message.id)).toEqual(["m1", "m2"]);
    expect(first).toMatchObject({ limited: true, limitReason: "message_count" });
    expect(first.nextCursor).toEqual(expect.any(String));
    const firstCursor = first.nextCursor;
    if (firstCursor === undefined) throw new Error("missing first cursor");

    const second = await readTranscriptPage(source, {
      threadId: "thr_reader",
      order: "chronological",
      limit: 2,
      cursor: firstCursor,
    });
    expect(second.messages.map((message) => message.id)).toEqual(["m3"]);
    expect(source.getCalls).toEqual(["m1", "m2", "m3"]);
    expect(source.listCalls[1]?.afterPosition).toBe(1);

    const reverseFirst = await readTranscriptPage(source, {
      threadId: "thr_reader",
      order: "reverse",
      limit: 2,
    });
    expect(reverseFirst.messages.map((message) => message.id)).toEqual(["m3", "m2"]);
    const reverseCursor = reverseFirst.nextCursor;
    if (reverseCursor === undefined) throw new Error("missing reverse cursor");

    const reverseSecond = await readTranscriptPage(source, {
      threadId: "thr_reader",
      order: "reverse",
      limit: 2,
      cursor: reverseCursor,
    });
    expect(reverseSecond.messages.map((message) => message.id)).toEqual(["m1"]);
  });

  it("caps reads at 50 messages", async () => {
    const source = new MemoryTranscriptSource(
      Array.from({ length: THREAD_READ_MAX_MESSAGES + 1 }, (_, index) =>
        textMessage({ id: `m${index}`, text: `message ${index}` }),
      ),
    );

    const result = await readTranscriptPage(source, { threadId: "thr_reader" });

    expect(result.messages).toHaveLength(THREAD_READ_MAX_MESSAGES);
    expect(result).toMatchObject({ limited: true, limitReason: "message_count" });
    expect(result.nextCursor).toEqual(expect.any(String));
  });

  it("caps reads at 32 KiB and marks an oversized message as truncated", async () => {
    const source = new MemoryTranscriptSource([
      textMessage({ id: "huge", text: "a".repeat(THREAD_READ_MAX_TEXT_BYTES + 100) }),
    ]);

    const result = await readTranscriptPage(source, { threadId: "thr_reader" });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.text.endsWith("\n[truncated]")).toBe(true);
    expect(new TextEncoder().encode(result.messages[0]?.text ?? "").byteLength).toBeLessThanOrEqual(
      THREAD_READ_MAX_TEXT_BYTES,
    );
    expect(result).toMatchObject({ limited: true, limitReason: "bytes" });
  });

  it("keeps the next unread message reachable when prior text exactly fills the byte limit", async () => {
    const source = new MemoryTranscriptSource([
      textMessage({ id: "full", text: "a".repeat(THREAD_READ_MAX_TEXT_BYTES) }),
      textMessage({ id: "next", text: "next message" }),
    ]);

    const first = await readTranscriptPage(source, { threadId: "thr_reader" });

    expect(first.messages.map((message) => message.id)).toEqual(["full"]);
    expect(first).toMatchObject({ limited: true, limitReason: "bytes" });
    expect(first.nextCursor).toEqual(expect.any(String));
    const nextCursor = first.nextCursor;
    if (nextCursor === undefined) throw new Error("missing byte-limit cursor");

    const second = await readTranscriptPage(source, {
      threadId: "thr_reader",
      cursor: nextCursor,
    });

    expect(second.messages.map((message) => message.id)).toEqual(["next"]);
    expect(source.getCalls).toEqual(["full", "next", "next"]);
  });

  it("omits date-filtered messages and counts hidden parts", async () => {
    const source = new MemoryTranscriptSource([
      textMessage({ id: "undated", text: "no date" }),
      textMessage({ id: "old", text: "old", createdAt: "2026-07-01T00:00:00.000Z" }),
      textMessage({
        id: "visible",
        role: "assistant",
        text: "visible",
        createdAt: "2026-07-10T00:00:00.000Z",
        extraParts: [
          { type: "reasoning", text: "hidden" },
          { type: "tool-result", result: "hidden" },
        ],
      }),
    ]);

    const result = await readTranscriptPage(source, {
      threadId: "thr_reader",
      since: "2026-07-05T00:00:00.000Z",
      until: "2026-07-15T00:00:00.000Z",
    });

    expect(result.messages.map((message) => message.id)).toEqual(["visible"]);
    expect(result.omittedPartCount).toBe(4);
  });

  it("stops at the shared source-scan cap and returns a limited result", async () => {
    const source = new MemoryTranscriptSource(
      Array.from({ length: THREAD_SOURCE_SCAN_MAX_MESSAGES + 1 }, (_, index) =>
        textMessage({ id: `m${index}`, text: "", extraParts: [{ type: "reasoning", text: "x" }] }),
      ),
    );

    const result = await readTranscriptPage(source, { threadId: "thr_reader" });

    expect(result.messages).toEqual([]);
    expect(result).toMatchObject({ limited: true, limitReason: "source_scan" });
    expect(result.nextCursor).toEqual(expect.any(String));
  });
});

describe("grepTranscript", () => {
  it("maps line matches to message metadata and context", async () => {
    const createdAt = "2026-07-30T12:00:00.000Z";
    const source = new MemoryTranscriptSource([
      textMessage({
        id: "m1",
        role: "assistant",
        text: "alpha\nneedle here\nomega",
        createdAt,
      }),
      textMessage({ id: "m2", text: "outside" }),
    ]);

    const result = await grepTranscript(source, {
      threadId: "thr_reader",
      pattern: "needle",
      contextLines: 1,
    });

    expect(result.matches).toEqual([
      {
        messageId: "m1",
        role: "assistant",
        createdAt: Date.parse(createdAt),
        line: 2,
        text: "needle here",
        before: ["alpha"],
        after: ["omega"],
      },
    ]);
    expect(result.limited).toBe(false);
  });

  it("rejects a 201-character regex using the shared grep pattern limit", async () => {
    const source = new MemoryTranscriptSource([textMessage({ id: "m1", text: "hello" })]);

    await expect(
      grepTranscript(source, {
        threadId: "thr_reader",
        pattern: "a".repeat(GREP_MAX_PATTERN_LENGTH + 1),
      }),
    ).rejects.toThrow("sandbox_grep_pattern_too_long");
  });

  it("returns limited grep results for output and source-scan caps", async () => {
    const outputLimited = await grepTranscript(
      new MemoryTranscriptSource([
        textMessage({ id: "m1", text: "needle one" }),
        textMessage({ id: "m2", text: "needle two" }),
      ]),
      { threadId: "thr_reader", pattern: "needle", maxMatches: 1 },
    );
    expect(outputLimited).toMatchObject({ limited: true, limitReason: "max_matches" });

    const sourceLimited = await grepTranscript(
      new MemoryTranscriptSource(
        Array.from({ length: THREAD_SOURCE_SCAN_MAX_MESSAGES + 1 }, (_, index) =>
          textMessage({ id: `m${index}`, text: "no match" }),
        ),
      ),
      { threadId: "thr_reader", pattern: "needle" },
    );
    expect(sourceLimited).toMatchObject({ limited: true, limitReason: "source_scan" });
  });
});
