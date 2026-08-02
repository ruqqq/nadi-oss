import { describe, expect, it, vi } from "vitest";
import { invalidatablePromiseCache } from "../../src/agent/promise-cache";

describe("invalidatablePromiseCache", () => {
  it("invokes the factory once across many get() calls", async () => {
    const fn = vi.fn(async () => "value");
    const cache = invalidatablePromiseCache(fn);

    await Promise.all([cache.get(), cache.get(), cache.get()]);
    await cache.get();

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("resolves to the factory's value", async () => {
    const cache = invalidatablePromiseCache(async () => 42);
    expect(await cache.get()).toBe(42);
  });

  it("shares a single in-flight factory call across concurrent get()s", async () => {
    let resolve!: (v: string) => void;
    const fn = vi.fn(() => new Promise<string>((r) => (resolve = r)));
    const cache = invalidatablePromiseCache(fn);

    const a = cache.get();
    const b = cache.get();
    resolve("shared");

    expect(await a).toBe("shared");
    expect(await b).toBe("shared");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not cache a rejection — the next get() retries", async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("recovered");
    const cache = invalidatablePromiseCache(fn);

    await expect(cache.get()).rejects.toThrow("boom");
    expect(await cache.get()).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("re-invokes the factory after invalidate()", async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("first")
      .mockResolvedValueOnce("second");
    const cache = invalidatablePromiseCache(fn);

    expect(await cache.get()).toBe("first");
    cache.invalidate();
    expect(await cache.get()).toBe("second");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
