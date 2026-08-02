import { describe, expect, test, vi } from "vitest";
import { findInactiveThreadIds } from "./thread-reconciliation";

describe("findInactiveThreadIds", () => {
  test("chunks every locally held ID and returns those absent from all active responses", async () => {
    const reconcile = vi.fn(async (ids: string[]) => ids.filter((id) => id !== "t150"));
    const ids = Array.from({ length: 205 }, (_, index) => `t${index}`);
    await expect(findInactiveThreadIds(ids, reconcile)).resolves.toEqual(new Set(["t150"]));
    expect(reconcile.mock.calls.map(([batch]) => batch.length)).toEqual([100, 100, 5]);
  });

  test("rejects without returning partial removals when any batch fails", async () => {
    const reconcile = vi
      .fn<(ids: string[]) => Promise<string[]>>()
      .mockResolvedValueOnce(["t0"])
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(
      findInactiveThreadIds(Array.from({ length: 101 }, (_, index) => `t${index}`), reconcile),
    ).rejects.toThrow("Failed to fetch");
  });
});
