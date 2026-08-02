import { describe, expect, it, vi } from "vitest";
import { RENEW_AFTER_MS, maybeRenewSession } from "./session-renewal";

const DAY = 24 * 60 * 60 * 1000;

function memoryStorage(initial?: Record<string, string>) {
  const map = new Map(Object.entries(initial ?? {}));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    read: (key: string) => map.get(key) ?? null,
  };
}

describe("maybeRenewSession", () => {
  it("renews when nothing has been recorded yet", async () => {
    const storage = memoryStorage();
    const getSession = vi.fn(async () => ({ authenticated: true as const, user: { id: "u1" } }));

    await maybeRenewSession({ getSession, now: () => 1_000_000, storage });

    expect(getSession).toHaveBeenCalledTimes(1);
  });

  it("records the renewal time so the next call can skip", async () => {
    const storage = memoryStorage();
    const getSession = vi.fn(async () => ({ authenticated: true as const, user: { id: "u1" } }));

    await maybeRenewSession({ getSession, now: () => 1_000_000, storage });

    expect(storage.read("nadi.session.renewedAt")).toBe("1000000");
  });

  it("skips a renewal made inside the window", async () => {
    const now = 10 * DAY;
    const storage = memoryStorage({
      "nadi.session.renewedAt": String(now - (RENEW_AFTER_MS - 1)),
    });
    const getSession = vi.fn(async () => ({ authenticated: true as const, user: { id: "u1" } }));

    await maybeRenewSession({ getSession, now: () => now, storage });

    expect(getSession).not.toHaveBeenCalled();
  });

  it("renews once the recorded time falls outside the window", async () => {
    const now = 10 * DAY;
    const storage = memoryStorage({
      "nadi.session.renewedAt": String(now - RENEW_AFTER_MS),
    });
    const getSession = vi.fn(async () => ({ authenticated: true as const, user: { id: "u1" } }));

    await maybeRenewSession({ getSession, now: () => now, storage });

    expect(getSession).toHaveBeenCalledTimes(1);
  });

  // A network failure must leave no trace, or an offline launch would mark the
  // session renewed and suppress the real attempt for the next 12 hours.
  it("swallows a failed renewal without recording it", async () => {
    const storage = memoryStorage();
    const getSession = vi.fn(async () => {
      throw new Error("offline");
    });

    await expect(
      maybeRenewSession({ getSession, now: () => 1_000_000, storage }),
    ).resolves.toBeUndefined();

    expect(storage.read("nadi.session.renewedAt")).toBeNull();
  });

  // The server is the only thing that can extend a session. An unauthenticated
  // reply means nothing was extended, so the next launch must try again.
  it("does not record a renewal the server refused", async () => {
    const storage = memoryStorage();
    const getSession = vi.fn(async () => ({ authenticated: false as const }));

    await maybeRenewSession({ getSession, now: () => 1_000_000, storage });

    expect(storage.read("nadi.session.renewedAt")).toBeNull();
  });

  // Storage is script-writable and gets evicted or corrupted; an unreadable
  // stamp must mean "renew now", never "skip forever".
  it("treats an unparseable stored time as due", async () => {
    const storage = memoryStorage({ "nadi.session.renewedAt": "not-a-number" });
    const getSession = vi.fn(async () => ({ authenticated: true as const, user: { id: "u1" } }));

    await maybeRenewSession({ getSession, now: () => 1_000_000, storage });

    expect(getSession).toHaveBeenCalledTimes(1);
  });

  it("survives storage that throws on read", async () => {
    const getSession = vi.fn(async () => ({ authenticated: true as const, user: { id: "u1" } }));
    const storage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };

    await expect(
      maybeRenewSession({ getSession, now: () => 1_000_000, storage }),
    ).resolves.toBeUndefined();

    expect(getSession).toHaveBeenCalledTimes(1);
  });
});
