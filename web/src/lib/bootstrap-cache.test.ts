// @vitest-environment jsdom
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { BootstrapData } from "../bootstrap-api";
import {
  BOOTSTRAP_CACHE_KEY,
  INACTIVE_THREAD_IDS_KEY,
  BOOTSTRAP_CACHE_VERSION,
  purgeCachedBootstrap,
  removeThreadsFromCachedBootstrap,
  readCachedBootstrap,
  writeCachedBootstrap,
} from "./bootstrap-cache";

function signedIn(): BootstrapData {
  return {
    appName: "Nadi",
    session: { authenticated: true, user: { id: "u1", email: "a@b.co" } },
    settings: null,
    threads: [],
    threadsNextCursor: null,
    projects: [],
    voiceEnabled: false,
    workersAiEnabled: true,
    feedbackAdminEnabled: false,
    backgroundWorkEnabled: false,
    workbenchNetworkAllowlistEnabled: false,
  };
}

describe("bootstrap-cache", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("round-trips a signed-in payload", () => {
    writeCachedBootstrap(signedIn());
    expect(readCachedBootstrap()).toEqual(signedIn());
  });

  test("returns null when nothing is cached", () => {
    expect(readCachedBootstrap()).toBeNull();
  });

  test("never writes a signed-out payload", () => {
    writeCachedBootstrap({ ...signedIn(), session: { authenticated: false } });
    expect(localStorage.getItem(BOOTSTRAP_CACHE_KEY)).toBeNull();
    expect(readCachedBootstrap()).toBeNull();
  });

  test("returns null on corrupt JSON", () => {
    localStorage.setItem(BOOTSTRAP_CACHE_KEY, "{not json");
    expect(readCachedBootstrap()).toBeNull();
  });

  test("returns null on a version mismatch", () => {
    localStorage.setItem(
      BOOTSTRAP_CACHE_KEY,
      JSON.stringify({ v: BOOTSTRAP_CACHE_VERSION + 1, cachedAt: 0, data: signedIn() }),
    );
    expect(readCachedBootstrap()).toBeNull();
  });

  test("returns null when the envelope shape is wrong", () => {
    localStorage.setItem(
      BOOTSTRAP_CACHE_KEY,
      JSON.stringify({ v: BOOTSTRAP_CACHE_VERSION, cachedAt: 0, data: { session: null } }),
    );
    expect(readCachedBootstrap()).toBeNull();
  });

  test("returns null when authenticated but user is missing", () => {
    const data = { ...signedIn(), session: { authenticated: true } };
    localStorage.setItem(
      BOOTSTRAP_CACHE_KEY,
      JSON.stringify({ v: BOOTSTRAP_CACHE_VERSION, cachedAt: 0, data }),
    );
    expect(readCachedBootstrap()).toBeNull();
  });

  test("returns null when user is malformed", () => {
    const data = { ...signedIn(), session: { authenticated: true, user: { id: 42 } } };
    localStorage.setItem(
      BOOTSTRAP_CACHE_KEY,
      JSON.stringify({ v: BOOTSTRAP_CACHE_VERSION, cachedAt: 0, data }),
    );
    expect(readCachedBootstrap()).toBeNull();
  });

  test("returns null when settings is a non-null non-object", () => {
    const data = { ...signedIn(), settings: "not-an-object" };
    localStorage.setItem(
      BOOTSTRAP_CACHE_KEY,
      JSON.stringify({ v: BOOTSTRAP_CACHE_VERSION, cachedAt: 0, data }),
    );
    expect(readCachedBootstrap()).toBeNull();
  });

  test("returns null when threads contains a non-object element", () => {
    const data = { ...signedIn(), threads: [{ threadId: "t1" }, "garbage"] };
    localStorage.setItem(
      BOOTSTRAP_CACHE_KEY,
      JSON.stringify({ v: BOOTSTRAP_CACHE_VERSION, cachedAt: 0, data }),
    );
    expect(readCachedBootstrap()).toBeNull();
  });

  test("returns null when settings is an empty object (workspace.id would crash)", () => {
    const data = { ...signedIn(), settings: {} };
    localStorage.setItem(
      BOOTSTRAP_CACHE_KEY,
      JSON.stringify({ v: BOOTSTRAP_CACHE_VERSION, cachedAt: 0, data }),
    );
    expect(readCachedBootstrap()).toBeNull();
  });

  test("returns null when settings.workspace is missing id", () => {
    const data = {
      ...signedIn(),
      settings: { workspace: { name: "ws" }, agent: {}, providers: [] },
    };
    localStorage.setItem(
      BOOTSTRAP_CACHE_KEY,
      JSON.stringify({ v: BOOTSTRAP_CACHE_VERSION, cachedAt: 0, data }),
    );
    expect(readCachedBootstrap()).toBeNull();
  });

  test("returns null when settings.providers is missing", () => {
    const data = {
      ...signedIn(),
      settings: { workspace: { id: "w1", name: "ws" }, agent: {} },
    };
    localStorage.setItem(
      BOOTSTRAP_CACHE_KEY,
      JSON.stringify({ v: BOOTSTRAP_CACHE_VERSION, cachedAt: 0, data }),
    );
    expect(readCachedBootstrap()).toBeNull();
  });

  test("returns null when a thread element is missing workspaceId", () => {
    const data = { ...signedIn(), threads: [{ threadId: "t1" }] };
    localStorage.setItem(
      BOOTSTRAP_CACHE_KEY,
      JSON.stringify({ v: BOOTSTRAP_CACHE_VERSION, cachedAt: 0, data }),
    );
    expect(readCachedBootstrap()).toBeNull();
  });

  test("returns null when settings is an array", () => {
    const data = { ...signedIn(), settings: [] };
    localStorage.setItem(
      BOOTSTRAP_CACHE_KEY,
      JSON.stringify({ v: BOOTSTRAP_CACHE_VERSION, cachedAt: 0, data }),
    );
    expect(readCachedBootstrap()).toBeNull();
  });

  test("accepts valid settings with workspace.id and providers", () => {
    const data = {
      ...signedIn(),
      settings: { workspace: { id: "w1", name: "ws" }, agent: {}, providers: [] },
      threads: [{ threadId: "t1", workspaceId: "w1", lastMessagePreview: "hi" }],
    };
    localStorage.setItem(
      BOOTSTRAP_CACHE_KEY,
      JSON.stringify({ v: BOOTSTRAP_CACHE_VERSION, cachedAt: 0, data }),
    );
    expect(readCachedBootstrap()).toEqual(data);
  });

  // The sidebar and full thread list both do `thread.lastMessagePreview.length`
  // with no fallback — a missing/non-string value here is a launch-time crash,
  // not a recoverable render, so the guard must reject it before it reaches
  // React state.
  test("returns null when a thread element is missing lastMessagePreview", () => {
    const data = { ...signedIn(), threads: [{ threadId: "t1", workspaceId: "w1" }] };
    localStorage.setItem(
      BOOTSTRAP_CACHE_KEY,
      JSON.stringify({ v: BOOTSTRAP_CACHE_VERSION, cachedAt: 0, data }),
    );
    expect(readCachedBootstrap()).toBeNull();
  });

  test("returns null when a thread's lastMessagePreview is not a string", () => {
    const data = {
      ...signedIn(),
      threads: [{ threadId: "t1", workspaceId: "w1", lastMessagePreview: null }],
    };
    localStorage.setItem(
      BOOTSTRAP_CACHE_KEY,
      JSON.stringify({ v: BOOTSTRAP_CACHE_VERSION, cachedAt: 0, data }),
    );
    expect(readCachedBootstrap()).toBeNull();
  });

  test("returns null when feedbackAdminEnabled is missing", () => {
    const { feedbackAdminEnabled: _missing, ...data } = signedIn();
    localStorage.setItem(
      BOOTSTRAP_CACHE_KEY,
      JSON.stringify({ v: BOOTSTRAP_CACHE_VERSION, cachedAt: 0, data }),
    );
    expect(readCachedBootstrap()).toBeNull();
  });

  test("returns null when backgroundWorkEnabled is missing", () => {
    const { backgroundWorkEnabled: _missing, ...data } = signedIn();
    localStorage.setItem(
      BOOTSTRAP_CACHE_KEY,
      JSON.stringify({ v: BOOTSTRAP_CACHE_VERSION, cachedAt: 0, data }),
    );
    expect(readCachedBootstrap()).toBeNull();
  });

  test("returns null when workbenchNetworkAllowlistEnabled is missing", () => {
    const { workbenchNetworkAllowlistEnabled: _missing, ...data } = signedIn();
    localStorage.setItem(
      BOOTSTRAP_CACHE_KEY,
      JSON.stringify({ v: BOOTSTRAP_CACHE_VERSION, cachedAt: 0, data }),
    );
    expect(readCachedBootstrap()).toBeNull();
  });

  test("purge removes the entry", () => {
    writeCachedBootstrap(signedIn());
    purgeCachedBootstrap();
    expect(readCachedBootstrap()).toBeNull();
  });

  // BOOTSTRAP_CACHE_VERSION must be bumped alongside shape changes; older
  // envelopes must be discarded before React reads them.
  test("rejects a v3 envelope under the current reader", () => {
    localStorage.setItem(
      BOOTSTRAP_CACHE_KEY,
      JSON.stringify({ v: 3, cachedAt: 0, data: signedIn() }),
    );
    expect(readCachedBootstrap()).toBeNull();
  });

  test("round-trips a current payload with a string threadsNextCursor", () => {
    const data = { ...signedIn(), threadsNextCursor: "abc" };
    writeCachedBootstrap(data);
    expect(readCachedBootstrap()).toEqual(data);
  });

  test("round-trips a current payload with threadsNextCursor: null", () => {
    const data = { ...signedIn(), threadsNextCursor: null };
    writeCachedBootstrap(data);
    expect(readCachedBootstrap()).toEqual(data);
  });

  test("removes confirmed inactive threads without damaging other bootstrap fields", () => {
    const keep = { threadId: "keep", workspaceId: "w1", lastMessagePreview: "keep" };
    const remove = { threadId: "remove", workspaceId: "w1", lastMessagePreview: "remove" };
    const data = {
      ...signedIn(),
      threads: [keep, remove],
      threadsNextCursor: "cursor_1",
      voiceEnabled: true,
    } as BootstrapData;
    writeCachedBootstrap(data);

    removeThreadsFromCachedBootstrap(["remove"]);

    expect(readCachedBootstrap()).toEqual({ ...data, threads: [keep] });
  });

  test("filters confirmed inactive threads from later stale bootstrap writes", () => {
    const keep = { threadId: "keep", workspaceId: "w1", lastMessagePreview: "keep" };
    const remove = { threadId: "remove", workspaceId: "w1", lastMessagePreview: "remove" };
    const initial = { ...signedIn(), threads: [keep, remove], voiceEnabled: true } as BootstrapData;
    writeCachedBootstrap(initial);

    removeThreadsFromCachedBootstrap(["remove"]);
    writeCachedBootstrap({ ...initial, threads: [remove, keep], voiceEnabled: false } as BootstrapData);

    expect(readCachedBootstrap()).toEqual({ ...initial, threads: [keep], voiceEnabled: false });
    expect(localStorage.getItem(INACTIVE_THREAD_IDS_KEY)).toContain("remove");
  });

  test("records inactive IDs even when no bootstrap cache exists", () => {
    removeThreadsFromCachedBootstrap(["remove"]);
    writeCachedBootstrap({
      ...signedIn(),
      threads: [{ threadId: "remove", workspaceId: "w1", lastMessagePreview: "stale" }],
    } as BootstrapData);
    expect(readCachedBootstrap()?.threads).toEqual([]);
  });

  test("a missing cache and storage failures are harmless", () => {
    expect(() => removeThreadsFromCachedBootstrap(["remove"])).not.toThrow();
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("disabled");
    });
    expect(() => removeThreadsFromCachedBootstrap(["remove"])).not.toThrow();
    getItem.mockRestore();
  });
});
