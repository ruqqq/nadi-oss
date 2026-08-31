import { describe, expect, it, vi } from "vitest";

const thread = { id: "thr_1", workspaceId: "ws_1", createdAt: 1 } as never;

function fakeDb() {
  return {} as never;
}

describe("createThreadWithWorkbench", () => {
  it("writes the environment assignment as part of the row", async () => {
    vi.resetModules();
    const createWithWorkbench = vi.fn().mockResolvedValue(undefined);
    vi.doMock("../../../src/db/repositories/threads", () => ({
      ThreadRepository: class {
        createWithWorkbench = createWithWorkbench;
      },
    }));
    const { createThreadWithWorkbench } = await import("../../../src/agent/create-thread");
    await createThreadWithWorkbench(fakeDb(), thread, "env_1");
    expect(createWithWorkbench).toHaveBeenCalledWith(thread, "env_1");
  });

  /**
   * There is no second write to keep consistent any more: the per-thread
   * configuration snapshot is gone, so assignment is one column on the insert.
   * That means no transaction, no D1-unsupported-transaction fallback, and no
   * compensating delete — a failure leaves nothing half-written.
   */
  it("propagates the insert failure without a compensating delete", async () => {
    vi.resetModules();
    const del = vi.fn().mockResolvedValue(undefined);
    vi.doMock("../../../src/db/repositories/threads", () => ({
      ThreadRepository: class {
        createWithWorkbench = vi.fn().mockRejectedValue(new Error("insert boom"));
        delete = del;
      },
    }));
    const { createThreadWithWorkbench } = await import("../../../src/agent/create-thread");
    await expect(createThreadWithWorkbench(fakeDb(), thread, "env_1")).rejects.toThrow(
      /insert boom/,
    );
    expect(del).not.toHaveBeenCalled();
  });
});
