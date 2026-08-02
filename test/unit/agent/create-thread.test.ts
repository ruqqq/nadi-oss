import { describe, expect, it, vi } from "vitest";

const thread = { id: "thr_1", workspaceId: "ws_1", createdAt: 1 } as never;

function fakeDb(overrides: { createWithWorkbench?: () => Promise<void> } = {}) {
  return { __overrides: overrides } as never;
}

describe("createThreadWithWorkbench", () => {
  it("writes through the transactional path when D1 accepts it", async () => {
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

  it("deletes the thread if the snapshot write fails on the fallback path", async () => {
    vi.resetModules();
    const del = vi.fn().mockResolvedValue(undefined);
    vi.doMock("../../../src/db/repositories/threads", () => ({
      ThreadRepository: class {
        createWithWorkbench = vi.fn().mockRejectedValue(new Error("Failed query: begin"));
        create = vi.fn().mockResolvedValue(undefined);
        delete = del;
      },
    }));
    vi.doMock("../../../src/db/repositories/thread-repository-snapshots", () => ({
      ThreadRepositorySnapshotRepository: class {
        replaceFromWorkbench = vi.fn().mockRejectedValue(new Error("snapshot boom"));
      },
    }));
    const { createThreadWithWorkbench } = await import("../../../src/agent/create-thread");
    await expect(createThreadWithWorkbench(fakeDb(), thread, "env_1")).rejects.toThrow(
      /snapshot boom/,
    );
    expect(del).toHaveBeenCalledWith("thr_1");
  });
});
