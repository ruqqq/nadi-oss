import { beforeEach, describe, expect, it, vi } from "vitest";
import { writeThenRefresh } from "./write-then-refresh";

const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error: toastError } }));

describe("writeThenRefresh", () => {
  beforeEach(() => {
    toastError.mockClear();
  });

  it("returns the write's value and reports nothing when both halves succeed", async () => {
    const refresh = vi.fn(async () => {});
    const result = await writeThenRefresh(async () => ({ id: "sk_1" }), refresh, "stale");

    expect(result).toEqual({ ok: true, value: { id: "sk_1" } });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();
  });

  /**
   * The whole point. A failed re-read is a stale VIEW, so the result stays
   * `ok` — a caller that reads `ok: false` here would roll back a write the
   * server accepted and tell the user it did not happen.
   */
  it("still succeeds when the refresh fails, and says the view is stale", async () => {
    const result = await writeThenRefresh(
      async () => "written",
      async () => {
        throw new Error("offline");
      },
      "Saved, but couldn’t reload the list.",
    );

    expect(result).toEqual({ ok: true, value: "written" });
    expect(toastError).toHaveBeenCalledExactlyOnceWith("Saved, but couldn’t reload the list.");
  });

  it("reports the write's own failure, and never refreshes past it", async () => {
    const boom = new Error("409");
    const refresh = vi.fn(async () => {});
    const result = await writeThenRefresh(
      async () => {
        throw boom;
      },
      refresh,
      "stale",
    );

    expect(result).toEqual({ ok: false, error: boom });
    // A refresh after a refused write would re-read rows the write never
    // changed and paint the failure as a no-op.
    expect(refresh).not.toHaveBeenCalled();
    // The caller owns how a refused write is reported; a toast from in here
    // would double up with theirs.
    expect(toastError).not.toHaveBeenCalled();
  });
});
