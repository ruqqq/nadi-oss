/**
 * Pure, storage-agnostic helpers for slicing compute process output.
 *
 * These operate on already-loaded `OutputChunkView[]` (as returned by
 * `ThreadComputeStore.listOutputChunks`) so they can be unit-tested without a
 * Durable Object, and reused by exec tools once output limits are enforced.
 */
export interface OutputChunkView {
  stream: "stdout" | "stderr";
  lineStart: number;
  lineEnd: number;
  byteStart: number;
  byteEnd: number;
  text: string;
}

/** Splits chunk text into newline-terminated (or trailing partial) lines. */
function splitLines(text: string): string[] {
  return text.split(/(?<=\n)/g).filter(Boolean);
}

export interface TailOutputInput {
  stream: "stdout" | "stderr";
  maxLines: number;
  maxBytes: number;
}

export interface TailOutputResult {
  text: string;
  limited: boolean;
  limitReason?: "max_bytes" | "retention";
}

export function tailOutputChunks(
  chunks: OutputChunkView[],
  input: TailOutputInput,
): TailOutputResult {
  // Clipping to the last `maxLines` is the normal, expected behavior of a
  // "tail" request (the caller asked for the recent window, not the whole
  // log) so it does NOT set `limited`. `limited` only fires when the
  // assembled tail itself has to be cut further to fit `maxBytes` — i.e. the
  // caller doesn't even get the full requested line window.
  const lines = chunks.filter((c) => c.stream === input.stream).flatMap((c) => splitLines(c.text));
  const selected = lines.slice(-input.maxLines);
  const text = selected.join("");
  if (new TextEncoder().encode(text).byteLength > input.maxBytes) {
    return { text: trimUtf8(text, input.maxBytes), limited: true, limitReason: "max_bytes" };
  }
  return { text, limited: false };
}

export interface GrepOutputInput {
  pattern: string;
  stream: "stdout" | "stderr" | "both";
  caseSensitive: boolean;
  contextLines: number;
  maxMatches: number;
  maxReturnedLines: number;
  maxBytes: number;
}

export interface GrepOutputMatch {
  line: number;
  stream: "stdout" | "stderr";
  lines: Array<{ stream: "stdout" | "stderr"; line: number; text: string }>;
}

export interface GrepOutputResult {
  matches: GrepOutputMatch[];
  limited: boolean;
  limitReason?: "max_matches" | "max_returned_lines" | "max_bytes" | "retention";
}

/** Longest model-supplied grep pattern we will compile (ReDoS mitigation). */
export const GREP_MAX_PATTERN_LENGTH = 200;
/** Longest per-line slice we run the regex against (bounds catastrophic backtracking). */
const GREP_MAX_LINE_SCAN_CHARS = 5_000;

export function grepOutputChunks(
  chunks: OutputChunkView[],
  input: GrepOutputInput,
): GrepOutputResult {
  // Cheap ReDoS mitigation: the pattern is model-supplied and compiled against
  // potentially large output. Reject pathologically long patterns outright and
  // bound the amount of text each line contributes to the match test so a
  // crafted pattern cannot force unbounded backtracking over a huge line.
  if (input.pattern.length > GREP_MAX_PATTERN_LENGTH) {
    throw new Error("sandbox_grep_pattern_too_long");
  }
  const regex = new RegExp(input.pattern, input.caseSensitive ? "" : "i");
  const selected = chunks.filter((c) => input.stream === "both" || c.stream === input.stream);
  const lines = selected.flatMap((chunk) =>
    splitLines(chunk.text).map((text, index) => ({
      stream: chunk.stream,
      line: chunk.lineStart + index,
      text,
    })),
  );

  const matches: GrepOutputMatch[] = [];
  let returnedLines = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index];
    if (!current) continue;
    const scanText =
      current.text.length > GREP_MAX_LINE_SCAN_CHARS
        ? current.text.slice(0, GREP_MAX_LINE_SCAN_CHARS)
        : current.text;
    if (!regex.test(scanText)) continue;

    const start = Math.max(0, index - input.contextLines);
    const end = Math.min(lines.length, index + input.contextLines + 1);
    const contextLines = lines.slice(start, end);

    if (returnedLines + contextLines.length > input.maxReturnedLines) {
      return { matches, limited: true, limitReason: "max_returned_lines" };
    }
    returnedLines += contextLines.length;

    matches.push({ line: current.line, stream: current.stream, lines: contextLines });
    if (matches.length >= input.maxMatches) {
      return { matches, limited: true, limitReason: "max_matches" };
    }
  }

  const totalBytes = matches.reduce(
    (sum, match) =>
      sum + match.lines.reduce((s, l) => s + new TextEncoder().encode(l.text).byteLength, 0),
    0,
  );
  if (totalBytes > input.maxBytes) {
    return { matches, limited: true, limitReason: "max_bytes" };
  }

  return { matches, limited: false };
}

export interface ReadOutputInput {
  stream: "stdout" | "stderr";
  startLine?: number;
  endLine?: number;
  /**
   * Byte offset into the stream to start reading from. When set, the read is a
   * byte-range slice (design doc: the fallback for output without reliable line
   * indexing) and `startLine`/`endLine`/`maxLines` are ignored.
   */
  startByte?: number;
  maxLines?: number;
  maxBytes: number;
}

export interface ReadOutputResult {
  text: string;
  limited: boolean;
  limitReason?: "max_bytes" | "max_lines" | "retention";
}

export function readOutputChunks(
  chunks: OutputChunkView[],
  input: ReadOutputInput,
): ReadOutputResult {
  const streamChunks = chunks.filter((c) => c.stream === input.stream);

  if (input.startByte !== undefined) {
    return readByteRange(streamChunks, input.startByte, input.maxBytes);
  }

  const startLine = input.startLine ?? 1;
  const endLine = input.endLine ?? Number.MAX_SAFE_INTEGER;
  const selected = streamChunks
    .flatMap((chunk) =>
      splitLines(chunk.text).map((lineText, index) => ({
        lineNo: chunk.lineStart + index,
        text: lineText,
      })),
    )
    .filter((line) => line.lineNo >= startLine && line.lineNo <= endLine);

  const maxLines = input.maxLines ?? Number.MAX_SAFE_INTEGER;
  const lineLimited = selected.length > maxLines;
  const kept = lineLimited ? selected.slice(0, maxLines) : selected;
  const text = kept.map((line) => line.text).join("");

  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > input.maxBytes) {
    return { text: trimUtf8(text, input.maxBytes), limited: true, limitReason: "max_bytes" };
  }
  return lineLimited ? { text, limited: true, limitReason: "max_lines" } : { text, limited: false };
}

/**
 * Byte-range read: assemble the stream's bytes starting at `startByte`, bounded
 * by `maxBytes`, using each chunk's cumulative `byteStart`/`byteEnd` so chunks
 * fully before the window are skipped without decoding. Slicing happens on
 * UTF-8 bytes (a multibyte char split at a window boundary is acceptable for
 * this fallback path), then the collected bytes are decoded once.
 */
function readByteRange(
  streamChunks: OutputChunkView[],
  startByte: number,
  maxBytes: number,
): ReadOutputResult {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  let collected = 0;
  let limited = false;
  for (const chunk of streamChunks) {
    if (chunk.byteEnd <= startByte) continue;
    const encoded = encoder.encode(chunk.text);
    const from = startByte > chunk.byteStart ? startByte - chunk.byteStart : 0;
    let slice = encoded.subarray(from);
    if (collected + slice.length > maxBytes) {
      slice = slice.subarray(0, maxBytes - collected);
      limited = true;
    }
    if (slice.length > 0) {
      parts.push(slice);
      collected += slice.length;
    }
    if (collected >= maxBytes) break;
  }
  const merged = new Uint8Array(collected);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }
  const text = new TextDecoder().decode(merged);
  return limited ? { text, limited: true, limitReason: "max_bytes" } : { text, limited: false };
}

export function trimUtf8(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return decoder.decode(encoder.encode(value).slice(0, maxBytes));
}
