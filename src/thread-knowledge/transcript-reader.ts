import {
  GREP_MAX_PATTERN_LENGTH,
  grepOutputChunks,
  type OutputChunkView,
  trimUtf8,
} from "../compute/output";
import { decodeKnowledgeCursor, encodeKnowledgeCursor, fingerprintKnowledgeQuery } from "./cursors";
import { parseDateInterval, timestampInInterval } from "./date-interval";
import { normalizeProseMessage } from "./prose-normalizer";
import type {
  GrepThreadMatch,
  InternalGrepRequest,
  InternalGrepResult,
  InternalReadRequest,
  InternalReadResult,
  RawTranscriptStat,
  ThreadOrder,
  ThreadProseMessage,
  TranscriptSource,
} from "./types";
import {
  THREAD_READ_MAX_MESSAGES,
  THREAD_READ_MAX_TEXT_BYTES,
  THREAD_SOURCE_SCAN_MAX_BYTES,
  THREAD_SOURCE_SCAN_MAX_MESSAGES,
} from "./types";

const READ_TRUNCATION_MARKER = "\n[truncated]";
const GREP_SOURCE_PAGE_LIMIT = 100;
const GREP_MAX_CONTEXT_LINES = 5;
const GREP_MAX_MATCHES = 50;
const GREP_MAX_RETURNED_LINES = 300;
const GREP_MAX_BYTES = 64_000;

type SourceScanState = {
  messages: number;
  bytes: number;
};

function readOrder(input: InternalReadRequest): ThreadOrder {
  return input.order ?? "chronological";
}

function readFingerprint(input: InternalReadRequest, order: ThreadOrder) {
  const interval = parseDateInterval(input);
  const query = {
    operation: "read" as const,
    threadId: input.threadId,
    includeAutomata: input.includeAutomata ?? false,
    order,
    ...(interval.since === undefined ? {} : { since: interval.since }),
    ...(interval.until === undefined ? {} : { until: interval.until }),
  };
  return {
    interval,
    fingerprint: fingerprintKnowledgeQuery(query),
  };
}

function decodeReadCursor(input: InternalReadRequest, fingerprint: string): number | undefined {
  if (input.cursor === undefined) return undefined;
  const cursor = decodeKnowledgeCursor(input.cursor, fingerprint);
  if (cursor?.operation !== "read") {
    throw new Error("invalid_cursor");
  }
  return cursor.position;
}

function encodeReadCursor(input: InternalReadRequest, order: ThreadOrder, stat: RawTranscriptStat) {
  const { fingerprint } = readFingerprint(input, order);
  return encodeKnowledgeCursor({
    version: 1,
    operation: "read",
    fingerprint,
    messageId: stat.id,
    position: stat.position,
  });
}

function shouldStopForSourceScan(
  scan: SourceScanState,
  index: number,
  stats: RawTranscriptStat[],
  nextPosition: number | undefined,
): boolean {
  if (
    scan.messages < THREAD_SOURCE_SCAN_MAX_MESSAGES &&
    scan.bytes < THREAD_SOURCE_SCAN_MAX_BYTES
  ) {
    return false;
  }
  return index < stats.length - 1 || nextPosition !== undefined;
}

function countDateOmission(inputHasDateBound: boolean): number {
  return inputHasDateBound ? 1 : 0;
}

function stripLineEnding(value: string): string {
  return value.replace(/\n$/, "");
}

function outputLineCount(text: string): number {
  return text.split(/(?<=\n)/g).filter(Boolean).length;
}

function appendWithinReadByteLimit(input: {
  messages: ThreadProseMessage[];
  message: ThreadProseMessage;
  usedBytes: number;
}): { usedBytes: number; added: boolean; limited: boolean } {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(input.message.text).byteLength;
  if (input.usedBytes + bytes <= THREAD_READ_MAX_TEXT_BYTES) {
    input.messages.push(input.message);
    return { usedBytes: input.usedBytes + bytes, added: true, limited: false };
  }

  const markerBytes = encoder.encode(READ_TRUNCATION_MARKER).byteLength;
  const remaining = THREAD_READ_MAX_TEXT_BYTES - input.usedBytes;
  if (remaining <= markerBytes) {
    return { usedBytes: input.usedBytes, added: false, limited: true };
  }

  const truncatedText = `${trimUtf8(input.message.text, remaining - markerBytes)}${READ_TRUNCATION_MARKER}`;
  input.messages.push({ ...input.message, text: truncatedText });
  return { usedBytes: THREAD_READ_MAX_TEXT_BYTES, added: true, limited: true };
}

export async function readTranscriptPage(
  source: TranscriptSource,
  input: InternalReadRequest,
): Promise<InternalReadResult> {
  const order = readOrder(input);
  const { interval, fingerprint } = readFingerprint(input, order);
  let afterPosition = decodeReadCursor(input, fingerprint);
  const limit = Math.min(
    Math.max(input.limit ?? THREAD_READ_MAX_MESSAGES, 1),
    THREAD_READ_MAX_MESSAGES,
  );
  const messages: ThreadProseMessage[] = [];
  const scan: SourceScanState = { messages: 0, bytes: 0 };
  let omittedPartCount = 0;
  let usedBytes = 0;
  const inputHasDateBound = interval.since !== undefined || interval.until !== undefined;
  let lastReturnedStat: RawTranscriptStat | undefined;

  while (messages.length < limit) {
    const page = await source.listStats({
      ...(afterPosition === undefined ? {} : { afterPosition }),
      order,
      limit: Math.min(limit, THREAD_SOURCE_SCAN_MAX_MESSAGES - scan.messages),
    });
    if (page.stats.length === 0) break;

    for (let index = 0; index < page.stats.length; index += 1) {
      const stat = page.stats[index];
      if (!stat) continue;
      scan.messages += 1;
      scan.bytes += stat.bytes;
      afterPosition = stat.position;

      const raw = await source.getMessage(stat.id);
      const normalized = normalizeProseMessage(raw);
      omittedPartCount += normalized.omittedPartCount;
      if (normalized.message === null) {
        if (shouldStopForSourceScan(scan, index, page.stats, page.nextPosition)) {
          return {
            messages,
            omittedPartCount,
            limited: true,
            limitReason: "source_scan",
            nextCursor: encodeReadCursor(input, order, stat),
          };
        }
        continue;
      }
      if (!timestampInInterval(normalized.message.createdAt, interval)) {
        omittedPartCount += countDateOmission(inputHasDateBound);
        if (shouldStopForSourceScan(scan, index, page.stats, page.nextPosition)) {
          return {
            messages,
            omittedPartCount,
            limited: true,
            limitReason: "source_scan",
            nextCursor: encodeReadCursor(input, order, stat),
          };
        }
        continue;
      }

      const appended = appendWithinReadByteLimit({
        messages,
        message: normalized.message,
        usedBytes,
      });
      usedBytes = appended.usedBytes;
      if (appended.limited) {
        const result: InternalReadResult = {
          messages,
          omittedPartCount,
          limited: true,
          limitReason: "bytes",
        };
        if (appended.added) {
          result.nextCursor = encodeReadCursor(input, order, stat);
        } else if (lastReturnedStat !== undefined) {
          result.nextCursor = encodeReadCursor(input, order, lastReturnedStat);
        } else if (input.cursor !== undefined) {
          result.nextCursor = input.cursor;
        }
        return result;
      }
      lastReturnedStat = stat;

      const hasMoreInSource = index < page.stats.length - 1 || page.nextPosition !== undefined;
      if (messages.length >= limit && hasMoreInSource) {
        return {
          messages,
          omittedPartCount,
          limited: true,
          limitReason: "message_count",
          nextCursor: encodeReadCursor(input, order, stat),
        };
      }
      if (shouldStopForSourceScan(scan, index, page.stats, page.nextPosition)) {
        return {
          messages,
          omittedPartCount,
          limited: true,
          limitReason: "source_scan",
          nextCursor: encodeReadCursor(input, order, stat),
        };
      }
    }

    if (page.nextPosition === undefined) break;
    afterPosition = page.nextPosition;
  }

  return { messages, omittedPartCount, limited: false };
}

function grepLimitReason(reason: string | undefined): string | undefined {
  return reason;
}

function runGrep(
  chunks: OutputChunkView[],
  input: InternalGrepRequest,
  lineOwners: Map<number, ThreadProseMessage>,
) {
  const grepResult = grepOutputChunks(chunks, {
    pattern: input.pattern,
    stream: "stdout",
    caseSensitive: input.caseSensitive ?? false,
    contextLines: Math.min(input.contextLines ?? 0, GREP_MAX_CONTEXT_LINES),
    maxMatches: Math.min(input.maxMatches ?? GREP_MAX_MATCHES, GREP_MAX_MATCHES),
    maxReturnedLines: GREP_MAX_RETURNED_LINES,
    maxBytes: GREP_MAX_BYTES,
  });
  return {
    matches: mapGrepMatches(grepResult.matches, lineOwners),
    limited: grepResult.limited,
    limitReason: grepLimitReason(grepResult.limitReason),
  };
}

function sourceScanLimitedGrepResult(input: {
  chunks: OutputChunkView[];
  request: InternalGrepRequest;
  lineOwners: Map<number, ThreadProseMessage>;
  omittedPartCount: number;
}): InternalGrepResult {
  const grepResult = runGrep(input.chunks, input.request, input.lineOwners);
  return {
    matches: grepResult.matches,
    omittedPartCount: input.omittedPartCount,
    limited: true,
    limitReason: "source_scan",
  };
}

export async function grepTranscript(
  source: TranscriptSource,
  input: InternalGrepRequest,
): Promise<InternalGrepResult> {
  if (input.pattern.length > GREP_MAX_PATTERN_LENGTH) {
    throw new Error("sandbox_grep_pattern_too_long");
  }
  const interval = parseDateInterval(input);
  const inputHasDateBound = interval.since !== undefined || interval.until !== undefined;
  const chunks: OutputChunkView[] = [];
  const lineOwners = new Map<number, ThreadProseMessage>();
  const scan: SourceScanState = { messages: 0, bytes: 0 };
  let omittedPartCount = 0;
  let afterPosition: number | undefined;
  let nextLine = 1;
  let nextByte = 0;

  while (
    scan.messages < THREAD_SOURCE_SCAN_MAX_MESSAGES &&
    scan.bytes < THREAD_SOURCE_SCAN_MAX_BYTES
  ) {
    const page = await source.listStats({
      ...(afterPosition === undefined ? {} : { afterPosition }),
      order: "chronological",
      limit: Math.min(GREP_SOURCE_PAGE_LIMIT, THREAD_SOURCE_SCAN_MAX_MESSAGES - scan.messages),
    });
    if (page.stats.length === 0) break;

    for (let index = 0; index < page.stats.length; index += 1) {
      const stat = page.stats[index];
      if (!stat) continue;
      scan.messages += 1;
      scan.bytes += stat.bytes;
      afterPosition = stat.position;

      const normalized = normalizeProseMessage(await source.getMessage(stat.id));
      omittedPartCount += normalized.omittedPartCount;
      if (normalized.message === null) {
        if (shouldStopForSourceScan(scan, index, page.stats, page.nextPosition)) {
          return sourceScanLimitedGrepResult({
            chunks,
            request: input,
            lineOwners,
            omittedPartCount,
          });
        }
        continue;
      }
      if (!timestampInInterval(normalized.message.createdAt, interval)) {
        omittedPartCount += countDateOmission(inputHasDateBound);
        if (shouldStopForSourceScan(scan, index, page.stats, page.nextPosition)) {
          return sourceScanLimitedGrepResult({
            chunks,
            request: input,
            lineOwners,
            omittedPartCount,
          });
        }
        continue;
      }

      const text = normalized.message.text.endsWith("\n")
        ? normalized.message.text
        : `${normalized.message.text}\n`;
      const lineCount = outputLineCount(text);
      for (let line = nextLine; line < nextLine + lineCount; line += 1) {
        lineOwners.set(line, normalized.message);
      }
      const byteLength = new TextEncoder().encode(text).byteLength;
      chunks.push({
        stream: "stdout",
        lineStart: nextLine,
        lineEnd: nextLine + lineCount - 1,
        byteStart: nextByte,
        byteEnd: nextByte + byteLength,
        text,
      });
      nextLine += lineCount;
      nextByte += byteLength;

      if (shouldStopForSourceScan(scan, index, page.stats, page.nextPosition)) {
        return sourceScanLimitedGrepResult({
          chunks,
          request: input,
          lineOwners,
          omittedPartCount,
        });
      }
    }

    if (page.nextPosition === undefined) break;
    afterPosition = page.nextPosition;
  }

  const grepResult = runGrep(chunks, input, lineOwners);
  const result: InternalGrepResult = {
    matches: grepResult.matches,
    omittedPartCount,
    limited: grepResult.limited,
  };
  if (grepResult.limitReason !== undefined) result.limitReason = grepResult.limitReason;
  return result;
}

function mapGrepMatches(
  matches: ReturnType<typeof grepOutputChunks>["matches"],
  lineOwners: Map<number, ThreadProseMessage>,
): GrepThreadMatch[] {
  return matches.flatMap((match) => {
    const owner = lineOwners.get(match.line);
    if (owner === undefined) return [];
    const currentIndex = match.lines.findIndex((line) => line.line === match.line);
    const current = match.lines[currentIndex];
    if (current === undefined) return [];
    return [
      {
        messageId: owner.id,
        role: owner.role,
        createdAt: owner.createdAt,
        line: match.line,
        text: stripLineEnding(current.text),
        before: match.lines.slice(0, currentIndex).map((line) => stripLineEnding(line.text)),
        after: match.lines.slice(currentIndex + 1).map((line) => stripLineEnding(line.text)),
      },
    ];
  });
}
