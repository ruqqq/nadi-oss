// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  installStaleBundleRecovery,
  isChunkLoadError,
  recoverFromStaleBundle,
  type StaleBundleOutcome,
} from "./stale-bundle";

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  } as Storage;
}

describe("isChunkLoadError", () => {
  // Every engine words this differently, and the one that matters most for a
  // Cloudflare SPA fallback is the MIME error: a chunk that no longer exists is
  // answered with index.html and a 200, not a 404.
  it.each([
    "Failed to fetch dynamically imported module: https://nadi.sh/assets/ChatLog-a1b2.js",
    "error loading dynamically imported module: https://nadi.sh/assets/ChatLog-a1b2.js",
    "Importing a module script failed.",
    'Failed to load module script: Expected a JavaScript module script but the server responded with a MIME type of "text/html".',
    "Unable to preload CSS for /assets/index-a1b2.css",
  ])("recognises %s", (message) => {
    expect(isChunkLoadError(new Error(message))).toBe(true);
  });

  it("recognises a webpack-style ChunkLoadError by name", () => {
    const error = new Error("Loading chunk 42 failed.");
    error.name = "ChunkLoadError";
    expect(isChunkLoadError(error)).toBe(true);
  });

  it("recognises a bare string reason", () => {
    expect(isChunkLoadError("Failed to fetch dynamically imported module")).toBe(true);
  });

  it("leaves ordinary app errors alone — a reload cannot fix those", () => {
    expect(isChunkLoadError(new Error("Workspace not found"))).toBe(false);
    expect(isChunkLoadError(new TypeError("Failed to fetch"))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError({ message: 42 })).toBe(false);
  });
});

describe("recoverFromStaleBundle", () => {
  let storage: Storage;
  let reload: Mock<() => void>;

  beforeEach(() => {
    storage = memoryStorage();
    reload = vi.fn<() => void>();
  });

  function deps(over: Partial<Parameters<typeof recoverFromStaleBundle>[0]> = {}) {
    return {
      storage,
      reload,
      now: () => 1_000_000,
      getRegistration: () => Promise.resolve(null),
      wait: () => Promise.resolve(),
      ...over,
    };
  }

  it("reloads straight away when there is no service worker", async () => {
    await expect(recoverFromStaleBundle(deps())).resolves.toBe("recovering");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("asks the worker to update, so the reload lands on the NEW precached shell", async () => {
    // A plain reload is served the old index.html out of the precache
    // (sw.ts routes navigations through createHandlerBoundToURL), so updating
    // the worker first is the whole point of this path.
    const update = vi.fn(() => Promise.resolve());
    await recoverFromStaleBundle(
      deps({ getRegistration: () => Promise.resolve({ update } as never) }),
    );
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("still reloads when the update finds nothing new (the wait times out)", async () => {
    const update = vi.fn(() => Promise.resolve());
    await recoverFromStaleBundle(
      deps({ getRegistration: () => Promise.resolve({ update } as never) }),
    );
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("still reloads when registration.update() rejects", async () => {
    const update = vi.fn(() => Promise.reject(new Error("offline")));
    await recoverFromStaleBundle(
      deps({ getRegistration: () => Promise.resolve({ update } as never) }),
    );
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("gives up instead of looping when a second failure lands inside the window", async () => {
    await recoverFromStaleBundle(deps({ now: () => 1_000_000 }));
    expect(reload).toHaveBeenCalledTimes(1);

    await expect(recoverFromStaleBundle(deps({ now: () => 1_030_000 }))).resolves.toBe("gave-up");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("recovers again once the window has passed", async () => {
    await recoverFromStaleBundle(deps({ now: () => 1_000_000 }));
    await expect(recoverFromStaleBundle(deps({ now: () => 1_100_000 }))).resolves.toBe(
      "recovering",
    );
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("reloads on an explicit retry even inside the window", async () => {
    await recoverFromStaleBundle(deps({ now: () => 1_000_000 }));
    await expect(
      recoverFromStaleBundle(deps({ now: () => 1_010_000, force: true })),
    ).resolves.toBe("recovering");
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("collapses a burst of failures into one recovery", async () => {
    const update = vi.fn(() => Promise.resolve());
    const registration = { update } as never;
    const all = await Promise.all([
      recoverFromStaleBundle(deps({ getRegistration: () => Promise.resolve(registration) })),
      recoverFromStaleBundle(deps({ getRegistration: () => Promise.resolve(registration) })),
      recoverFromStaleBundle(deps({ getRegistration: () => Promise.resolve(registration) })),
    ]);
    expect(all).toEqual(["recovering", "recovering", "recovering"]);
    expect(update).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("survives storage that throws (Safari private mode) without wedging", async () => {
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    } as unknown as Storage;
    await expect(recoverFromStaleBundle(deps({ storage: throwing }))).resolves.toBe("recovering");
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("installStaleBundleRecovery", () => {
  let teardown: (() => void) | undefined;
  let recover: Mock<() => Promise<StaleBundleOutcome>>;

  beforeEach(() => {
    recover = vi.fn<() => Promise<StaleBundleOutcome>>(() => Promise.resolve("recovering"));
  });

  afterEach(() => {
    teardown?.();
    teardown = undefined;
  });

  it("recovers on Vite's preload error", () => {
    teardown = installStaleBundleRecovery({ recover });
    const event = new Event("vite:preloadError", { cancelable: true });
    window.dispatchEvent(event);
    expect(recover).toHaveBeenCalledTimes(1);
    // Swallowed: Vite rethrows the error into the page otherwise, and we are
    // already handling it.
    expect(event.defaultPrevented).toBe(true);
  });

  it("recovers on a chunk-load unhandled rejection", () => {
    teardown = installStaleBundleRecovery({ recover });
    const event = new Event("unhandledrejection") as Event & { reason: unknown };
    Object.defineProperty(event, "reason", {
      value: new Error("Failed to fetch dynamically imported module: /assets/ChatLog-a1.js"),
    });
    window.dispatchEvent(event);
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it("recovers on a chunk-load window error event", () => {
    teardown = installStaleBundleRecovery({ recover });
    const event = new Event("error") as Event & { error: unknown };
    Object.defineProperty(event, "error", { value: new Error("Importing a module script failed.") });
    window.dispatchEvent(event);
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it("ignores ordinary errors — reloading would hide a real bug", () => {
    teardown = installStaleBundleRecovery({ recover });
    const event = new Event("unhandledrejection") as Event & { reason: unknown };
    Object.defineProperty(event, "reason", { value: new Error("Boom") });
    window.dispatchEvent(event);
    expect(recover).not.toHaveBeenCalled();
  });

  it("stops listening after teardown", () => {
    const stop = installStaleBundleRecovery({ recover });
    stop();
    window.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));
    expect(recover).not.toHaveBeenCalled();
  });
});
