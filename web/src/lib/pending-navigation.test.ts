import { beforeEach, describe, expect, it } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import {
  PENDING_NAVIGATION_TTL_MS,
  claimPendingThreadNavigation,
  clearPendingThreadNavigation,
  savePendingThreadNavigation,
} from "./pending-navigation";

beforeEach(() => {
  indexedDB = new IDBFactory();
});

describe("pending thread navigation", () => {
  it("claims a saved thread id exactly once", async () => {
    await savePendingThreadNavigation("thr_001", 1_000);

    expect(await claimPendingThreadNavigation(1_500)).toBe("thr_001");
    // The claim consumes the record, so a later resume cannot yank the user
    // back into the thread they already left.
    expect(await claimPendingThreadNavigation(1_600)).toBeNull();
  });

  it("returns null when nothing is pending", async () => {
    expect(await claimPendingThreadNavigation(1_000)).toBeNull();
  });

  it("drops a record older than the TTL", async () => {
    await savePendingThreadNavigation("thr_001", 1_000);

    expect(await claimPendingThreadNavigation(1_000 + PENDING_NAVIGATION_TTL_MS + 1)).toBeNull();
  });

  it("keeps only the most recent tap", async () => {
    await savePendingThreadNavigation("thr_001", 1_000);
    await savePendingThreadNavigation("thr_002", 1_100);

    expect(await claimPendingThreadNavigation(1_200)).toBe("thr_002");
  });

  it("clears a pending record without claiming it", async () => {
    await savePendingThreadNavigation("thr_001", 1_000);
    await clearPendingThreadNavigation();

    expect(await claimPendingThreadNavigation(1_100)).toBeNull();
  });

  it("degrades to null when IndexedDB is unavailable", async () => {
    const original = indexedDB;
    (globalThis as { indexedDB?: unknown }).indexedDB = undefined;
    try {
      await expect(savePendingThreadNavigation("thr_001", 1_000)).resolves.toBeUndefined();
      await expect(claimPendingThreadNavigation(1_000)).resolves.toBeNull();
    } finally {
      indexedDB = original;
    }
  });
});
