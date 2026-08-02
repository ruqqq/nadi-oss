// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fetchThreadHistory, fetchThreadHistoryDetailed } from "./thread-history-fetch";
import { readCachedHistory, writeCachedHistory } from "./thread-history-cache";
import type { CachedMessages } from "./thread-history-cache-policy";

vi.mock("./thread-history-cache", () => ({
  readCachedHistory: vi.fn(),
  writeCachedHistory: vi.fn(),
  purgeCachedHistory: vi.fn(),
}));

const readCachedHistoryMock = vi.mocked(readCachedHistory);
const writeCachedHistoryMock = vi.mocked(writeCachedHistory);

const target = { kind: "legacy" as const, path: "/agents/thread-agent/t1/get-messages" };

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchThreadHistory", () => {
  test("returns a bare message array", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ id: "m1" }])));
    expect(await fetchThreadHistory(target)).toEqual([{ id: "m1" }]);
  });

  test("unwraps a { messages } envelope", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ messages: [{ id: "m1" }] })));
    expect(await fetchThreadHistory(target)).toEqual([{ id: "m1" }]);
  });

  test("returns [] on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, false)));
    expect(await fetchThreadHistory(target)).toEqual([]);
  });

  test("returns [] on an unparseable body", async () => {
    const res = {
      ok: true,
      json: () => Promise.reject(new Error("bad json")),
    } as unknown as Response;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res));
    expect(await fetchThreadHistory(target)).toEqual([]);
  });

  test("returns [] when the body is neither an array nor an envelope", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ nope: true })));
    expect(await fetchThreadHistory(target)).toEqual([]);
  });

  test("sends credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    await fetchThreadHistory(target);
    expect(fetchMock).toHaveBeenCalledWith(target.path, { credentials: "include" });
  });

  test("propagates a network rejection", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(fetchThreadHistory(target)).rejects.toThrow("Failed to fetch");
  });
});

describe("fetchThreadHistory cache read-through", () => {
  const cacheTarget = { kind: "legacy" as const, path: "/agents/thread-agent/t1/get-messages" };
  const cached = [{ id: "cached" }] as CachedMessages;

  beforeEach(() => {
    readCachedHistoryMock.mockResolvedValue(null);
    writeCachedHistoryMock.mockResolvedValue(undefined);
  });

  test("a successful fetch writes the cache", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ id: "m1" }])));
    await fetchThreadHistory(cacheTarget, { threadId: "t1" });
    expect(writeCachedHistoryMock).toHaveBeenCalledWith("t1", [{ id: "m1" }]);
  });

  test("a legitimately empty transcript is still cached", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([])));
    await fetchThreadHistory(cacheTarget, { threadId: "t1" });
    expect(writeCachedHistoryMock).toHaveBeenCalledWith("t1", []);
  });

  test("a network rejection falls back to the cache when opted in", async () => {
    readCachedHistoryMock.mockResolvedValue(cached);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    const result = await fetchThreadHistory(cacheTarget, { threadId: "t1", fallbackToCache: true });
    expect(result).toEqual(cached);
    expect(readCachedHistoryMock).toHaveBeenCalledWith("t1");
  });

  test("a network rejection with no cached entry re-throws", async () => {
    readCachedHistoryMock.mockResolvedValue(null);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(
      fetchThreadHistory(cacheTarget, { threadId: "t1", fallbackToCache: true }),
    ).rejects.toThrow("Failed to fetch");
  });

  // The resync guard: syncThreadHistory must never report success on our own
  // cache — it would setMessages(stale) and clear historyReloading as though it
  // had reached the server.
  test("a network rejection does NOT read the cache when not opted in", async () => {
    readCachedHistoryMock.mockResolvedValue(cached);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    await expect(fetchThreadHistory(cacheTarget, { threadId: "t1" })).rejects.toThrow(
      "Failed to fetch",
    );
    expect(readCachedHistoryMock).not.toHaveBeenCalled();
  });

  // An expired session degrades to [] — writing that would destroy the very
  // history the cache exists to preserve.
  test("a non-ok response does NOT write the cache", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, false)));

    expect(await fetchThreadHistory(cacheTarget, { threadId: "t1" })).toEqual([]);
    expect(writeCachedHistoryMock).not.toHaveBeenCalled();
  });

  test("a non-ok response does NOT read the cache either", async () => {
    readCachedHistoryMock.mockResolvedValue(cached);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, false)));

    expect(
      await fetchThreadHistory(cacheTarget, { threadId: "t1", fallbackToCache: true }),
    ).toEqual([]);
    expect(readCachedHistoryMock).not.toHaveBeenCalled();
  });

  test("an unparseable body does NOT write the cache", async () => {
    const res = {
      ok: true,
      json: () => Promise.reject(new Error("bad json")),
    } as unknown as Response;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res));

    expect(await fetchThreadHistory(cacheTarget, { threadId: "t1" })).toEqual([]);
    expect(writeCachedHistoryMock).not.toHaveBeenCalled();
  });

  test("no threadId means no cache interaction at all", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ id: "m1" }])));
    await fetchThreadHistory(cacheTarget);
    expect(writeCachedHistoryMock).not.toHaveBeenCalled();
    expect(readCachedHistoryMock).not.toHaveBeenCalled();
  });
});

// `degraded` is what stops ThreadChat from persisting a truncated transcript
// over a good cache: every branch that returns a stand-in [] must say so, and
// every branch returning a real transcript must not.
describe("fetchThreadHistoryDetailed degraded signal", () => {
  const cached = [{ id: "cached" }] as CachedMessages;

  beforeEach(() => {
    readCachedHistoryMock.mockResolvedValue(null);
    writeCachedHistoryMock.mockResolvedValue(undefined);
  });

  test("a non-ok response is degraded", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, false)));
    expect(await fetchThreadHistoryDetailed(target)).toEqual({ messages: [], degraded: true });
  });

  test("an unparseable body is degraded", async () => {
    const res = {
      ok: true,
      json: () => Promise.reject(new Error("bad json")),
    } as unknown as Response;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res));
    expect(await fetchThreadHistoryDetailed(target)).toEqual({ messages: [], degraded: true });
  });

  test("a body of neither shape is degraded", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ nope: true })));
    expect(await fetchThreadHistoryDetailed(target)).toEqual({ messages: [], degraded: true });
  });

  test("a healthy parse is not degraded", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ id: "m1" }])));
    expect(await fetchThreadHistoryDetailed(target)).toEqual({
      messages: [{ id: "m1" }],
      degraded: false,
    });
  });

  // A real empty thread is not a failure — it must stay writable.
  test("a legitimately empty transcript is not degraded", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([])));
    expect(await fetchThreadHistoryDetailed(target)).toEqual({ messages: [], degraded: false });
  });

  // The cached messages ARE the truth offline; writing them back is a no-op.
  test("an offline cache hit is not degraded", async () => {
    readCachedHistoryMock.mockResolvedValue(cached);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    expect(
      await fetchThreadHistoryDetailed(target, { threadId: "t1", fallbackToCache: true }),
    ).toEqual({ messages: cached, degraded: false });
  });
});
