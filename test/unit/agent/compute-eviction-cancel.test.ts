import { describe, expect, it, vi } from "vitest";
import {
  cancelComputeEviction,
  COMPUTE_EVICTION_SCHEDULE_KEY,
} from "../../../src/agent/compute-tools";

function storageBackedBy(map: Map<string, unknown>): DurableObjectStorage {
  return {
    get: async (key: string) => map.get(key),
    delete: async (key: string) => map.delete(key),
  } as unknown as DurableObjectStorage;
}

describe("cancelComputeEviction", () => {
  it("cancels the stored schedule and forgets its id", async () => {
    const map = new Map<string, unknown>([[COMPUTE_EVICTION_SCHEDULE_KEY, "sched_1"]]);
    const cancelSchedule = vi.fn().mockResolvedValue(true);

    await cancelComputeEviction({ storage: storageBackedBy(map), cancelSchedule });

    expect(cancelSchedule).toHaveBeenCalledWith("sched_1");
    expect(map.has(COMPUTE_EVICTION_SCHEDULE_KEY)).toBe(false);
  });

  it("is a no-op when no schedule id is stored", async () => {
    const cancelSchedule = vi.fn();

    await cancelComputeEviction({ storage: storageBackedBy(new Map()), cancelSchedule });

    expect(cancelSchedule).not.toHaveBeenCalled();
  });

  it("still forgets the id when cancelSchedule throws (schedule already fired)", async () => {
    const map = new Map<string, unknown>([[COMPUTE_EVICTION_SCHEDULE_KEY, "sched_x"]]);

    await cancelComputeEviction({
      storage: storageBackedBy(map),
      cancelSchedule: async () => {
        throw new Error("already fired");
      },
    });

    expect(map.has(COMPUTE_EVICTION_SCHEDULE_KEY)).toBe(false);
  });
});
