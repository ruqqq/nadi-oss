import type { ThreadProseMessage } from "./types";

export type NormalizeProseResult = {
  message: ThreadProseMessage | null;
  omittedPartCount: number;
};

export function normalizeCreatedAt(value: unknown): number | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function normalizeProseMessage(raw: unknown): NormalizeProseResult {
  if (typeof raw !== "object" || raw === null) return { message: null, omittedPartCount: 1 };
  const candidate = raw as { id?: unknown; role?: unknown; createdAt?: unknown; parts?: unknown };
  if (typeof candidate.id !== "string" || candidate.id.startsWith("compaction_")) {
    return { message: null, omittedPartCount: 1 };
  }
  if (candidate.role !== "user" && candidate.role !== "assistant") {
    return { message: null, omittedPartCount: 1 };
  }
  if (!Array.isArray(candidate.parts)) return { message: null, omittedPartCount: 1 };

  const text: string[] = [];
  let omittedPartCount = 0;
  for (const part of candidate.parts) {
    if (
      typeof part === "object" &&
      part !== null &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
    ) {
      const value = (part as { text: string }).text.trim();
      if (value !== "") text.push(value);
    } else {
      omittedPartCount += 1;
    }
  }
  if (text.length === 0) return { message: null, omittedPartCount };
  return {
    message: {
      id: candidate.id,
      role: candidate.role,
      text: text.join("\n"),
      createdAt: normalizeCreatedAt(candidate.createdAt),
    },
    omittedPartCount,
  };
}
