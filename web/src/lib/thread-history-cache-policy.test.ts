import { describe, expect, test } from "vitest";
import {
  THREAD_HISTORY_CACHE_VERSION,
  evictionPlan,
  isCachedHistoryEnvelope,
  shouldPersistSettledMessages,
} from "./thread-history-cache-policy";

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    v: THREAD_HISTORY_CACHE_VERSION,
    cachedAt: 1,
    lastOpenedAt: 2,
    threadId: "t1",
    messages: [{ id: "m1", role: "user", parts: [] }],
    ...overrides,
  };
}

describe("isCachedHistoryEnvelope", () => {
  test("accepts a well-formed envelope", () => {
    expect(isCachedHistoryEnvelope(envelope())).toBe(true);
  });

  test("accepts an empty message array", () => {
    expect(isCachedHistoryEnvelope(envelope({ messages: [] }))).toBe(true);
  });

  test("rejects a stale version", () => {
    expect(isCachedHistoryEnvelope(envelope({ v: THREAD_HISTORY_CACHE_VERSION + 1 }))).toBe(false);
  });

  test("rejects non-objects and null", () => {
    expect(isCachedHistoryEnvelope(null)).toBe(false);
    expect(isCachedHistoryEnvelope("nope")).toBe(false);
    expect(isCachedHistoryEnvelope([])).toBe(false);
  });

  test("rejects a missing or non-array messages field", () => {
    expect(isCachedHistoryEnvelope(envelope({ messages: undefined }))).toBe(false);
    expect(isCachedHistoryEnvelope(envelope({ messages: "x" }))).toBe(false);
  });

  test("rejects messages whose elements lack a string id", () => {
    expect(isCachedHistoryEnvelope(envelope({ messages: [{ role: "user" }] }))).toBe(false);
  });

  test("rejects a non-string threadId", () => {
    expect(isCachedHistoryEnvelope(envelope({ threadId: 7 }))).toBe(false);
  });
});

describe("evictionPlan", () => {
  const entries = [
    { threadId: "old", lastOpenedAt: 10 },
    { threadId: "mid", lastOpenedAt: 20 },
    { threadId: "new", lastOpenedAt: 30 },
  ];

  test("evicts nothing under the cap", () => {
    expect(evictionPlan(entries, 5)).toEqual([]);
  });

  test("evicts nothing exactly at the cap", () => {
    expect(evictionPlan(entries, 3)).toEqual([]);
  });

  test("evicts the least-recently-opened first", () => {
    expect(evictionPlan(entries, 2)).toEqual(["old"]);
  });

  test("evicts as many as needed to reach the cap", () => {
    expect(evictionPlan(entries, 1)).toEqual(["old", "mid"]);
  });

  test("does not mutate its input", () => {
    const input = [...entries];
    evictionPlan(input, 1);
    expect(input).toEqual(entries);
  });
});

describe("shouldPersistSettledMessages", () => {
  test("does not persist mid-stream", () => {
    expect(shouldPersistSettledMessages(true, 3)).toBe(false);
  });

  test("persists once the turn settles", () => {
    expect(shouldPersistSettledMessages(false, 3)).toBe(true);
  });

  test("does not persist an empty transcript", () => {
    expect(shouldPersistSettledMessages(false, 0)).toBe(false);
  });
});
