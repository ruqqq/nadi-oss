import type { ThreadOrder, ThreadStatusFilter } from "./types";

export type KnowledgeCursor =
  | { version: 1; operation: "list"; fingerprint: string; updatedAt: number; id: string }
  | { version: 1; operation: "search"; fingerprint: string; offset: number }
  | {
      version: 1;
      operation: "read";
      fingerprint: string;
      messageId: string;
      position: number;
    };

export type KnowledgeQueryFingerprintInput =
  | {
      operation: "list";
      status?: ThreadStatusFilter;
      projectId?: string;
      includeAutomata?: boolean;
      since?: number;
      until?: number;
    }
  | {
      operation: "search";
      query: string;
      status?: ThreadStatusFilter;
      projectId?: string;
      includeAutomata?: boolean;
      since?: number;
      until?: number;
    }
  | {
      operation: "read";
      threadId: string;
      includeAutomata?: boolean;
      since?: number;
      until?: number;
      order?: ThreadOrder;
    };

function fnv1a32(raw: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function canonicalJson(value: Record<string, unknown>): string {
  const keys = Object.keys(value).sort();
  const sorted: Record<string, unknown> = {};
  for (const key of keys) {
    sorted[key] = value[key];
  }
  return JSON.stringify(sorted);
}

function buildFingerprintPayload(input: KnowledgeQueryFingerprintInput): Record<string, unknown> {
  switch (input.operation) {
    case "list":
      return {
        includeAutomata: input.includeAutomata ?? false,
        operation: "list",
        projectId: input.projectId ?? "",
        since: input.since ?? null,
        status: input.status ?? "all",
        until: input.until ?? null,
      };
    case "search":
      return {
        includeAutomata: input.includeAutomata ?? false,
        operation: "search",
        projectId: input.projectId ?? "",
        query: input.query,
        since: input.since ?? null,
        status: input.status ?? "all",
        until: input.until ?? null,
      };
    case "read":
      return {
        includeAutomata: input.includeAutomata ?? false,
        operation: "read",
        order: input.order ?? "chronological",
        since: input.since ?? null,
        threadId: input.threadId,
        until: input.until ?? null,
      };
  }
}

export function fingerprintKnowledgeQuery(input: KnowledgeQueryFingerprintInput): string {
  return fnv1a32(canonicalJson(buildFingerprintPayload(input)));
}

export function encodeKnowledgeCursor(cursor: KnowledgeCursor): string {
  return btoa(JSON.stringify(cursor));
}

function isValidListCursor(
  value: Record<string, unknown>,
): value is Extract<KnowledgeCursor, { operation: "list" }> {
  return (
    value.version === 1 &&
    value.operation === "list" &&
    typeof value.fingerprint === "string" &&
    value.fingerprint !== "" &&
    typeof value.updatedAt === "number" &&
    Number.isFinite(value.updatedAt) &&
    typeof value.id === "string" &&
    value.id !== ""
  );
}

function isValidSearchCursor(
  value: Record<string, unknown>,
): value is Extract<KnowledgeCursor, { operation: "search" }> {
  return (
    value.version === 1 &&
    value.operation === "search" &&
    typeof value.fingerprint === "string" &&
    value.fingerprint !== "" &&
    typeof value.offset === "number" &&
    Number.isFinite(value.offset) &&
    value.offset >= 0
  );
}

function isValidReadCursor(
  value: Record<string, unknown>,
): value is Extract<KnowledgeCursor, { operation: "read" }> {
  return (
    value.version === 1 &&
    value.operation === "read" &&
    typeof value.fingerprint === "string" &&
    value.fingerprint !== "" &&
    typeof value.messageId === "string" &&
    value.messageId !== "" &&
    typeof value.position === "number" &&
    Number.isFinite(value.position) &&
    value.position >= 0
  );
}

export function decodeKnowledgeCursor(
  raw: string,
  expectedFingerprint?: string,
): KnowledgeCursor | null {
  let decoded: string;
  try {
    decoded = atob(raw);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const value = parsed as Record<string, unknown>;
  if (value.version !== 1) return null;

  let cursor: KnowledgeCursor | null = null;
  if (isValidListCursor(value)) {
    cursor = value;
  } else if (isValidSearchCursor(value)) {
    cursor = value;
  } else if (isValidReadCursor(value)) {
    cursor = value;
  }
  if (cursor === null) return null;
  if (expectedFingerprint !== undefined && cursor.fingerprint !== expectedFingerprint) {
    return null;
  }
  return cursor;
}
