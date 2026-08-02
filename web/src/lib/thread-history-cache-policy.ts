/**
 * Pure decision logic for the offline thread-history cache. The IndexedDB glue
 * lives in thread-history-cache.ts; keeping the decisions pure makes them
 * unit-testable in the node env (same split as connection-recovery.ts /
 * use-connection-recovery.ts, offline-state.ts / use-offline.tsx).
 */
import type { useAgentChat } from "@cloudflare/think/react";

export type CachedMessages = ReturnType<typeof useAgentChat>["messages"];

/**
 * Envelope version. BUMP THIS whenever the persisted message shape changes.
 * Without it, a deploy that changes the shape would rehydrate an incompatible
 * transcript straight into React state.
 */
export const THREAD_HISTORY_CACHE_VERSION = 1;

/** LRU bound on stored threads. A storage cap, not a coverage rule: every
 *  thread you open is cached, this only decides which old ones fall off. */
export const THREAD_HISTORY_CACHE_CAP = 50;

export interface CachedHistoryEnvelope {
  v: number;
  cachedAt: number;
  lastOpenedAt: number;
  threadId: string;
  messages: CachedMessages;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural check — a stale or hand-edited record must never reach React
 *  state. Validates the envelope plus the one field the render path
 *  dereferences on every message (`id`); deeper drift is handled by bumping
 *  THREAD_HISTORY_CACHE_VERSION. */
export function isCachedHistoryEnvelope(value: unknown): value is CachedHistoryEnvelope {
  if (!isPlainObject(value)) return false;
  if (value.v !== THREAD_HISTORY_CACHE_VERSION) return false;
  if (typeof value.cachedAt !== "number") return false;
  if (typeof value.lastOpenedAt !== "number") return false;
  if (typeof value.threadId !== "string") return false;
  if (!Array.isArray(value.messages)) return false;
  return value.messages.every((message) => isPlainObject(message) && typeof message.id === "string");
}

/** Which threadIds to drop so that at most `cap` remain, least-recently-opened
 *  first. Pure: returns the plan, applies nothing. */
export function evictionPlan(
  entries: { threadId: string; lastOpenedAt: number }[],
  cap: number,
): string[] {
  if (entries.length <= cap) return [];
  return [...entries]
    .sort((a, b) => a.lastOpenedAt - b.lastOpenedAt)
    .slice(0, entries.length - cap)
    .map((entry) => entry.threadId);
}

/** Persist only a settled transcript: a half-streamed assistant message must
 *  never be cached as though it were complete. */
export function shouldPersistSettledMessages(isStreaming: boolean, messageCount: number): boolean {
  return !isStreaming && messageCount > 0;
}
