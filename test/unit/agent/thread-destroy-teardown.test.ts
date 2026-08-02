import { describe, expect, it, vi } from "vitest";
import { teardownThreadBeforeDestroy } from "../../../src/agent/thread-destroy-teardown";

describe("teardownThreadBeforeDestroy", () => {
  it("is a no-op when compute resolution finds no compute service", async () => {
    const cancelActiveSubagents = vi.fn();

    await expect(
      teardownThreadBeforeDestroy({
        threadId: "thread_none",
        logPrefix: "thread",
        cancelActiveSubagents,
        resolveComputeService: async () => null,
      }),
    ).resolves.toBeUndefined();

    expect(cancelActiveSubagents).toHaveBeenCalledOnce();
  });

  it("does not block destroy when compute reaping throws", async () => {
    const execShutdown = vi.fn().mockRejectedValue(new Error("compute unavailable"));

    await expect(
      teardownThreadBeforeDestroy({
        threadId: "thread_error",
        logPrefix: "thread",
        resolveComputeService: async () => ({ service: { execShutdown } }),
      }),
    ).resolves.toBeUndefined();

    expect(execShutdown).toHaveBeenCalledWith({ confirm: true });
  });

  it("REGRESSION (I2): releases the quota row even when execShutdown throws", async () => {
    // execShutdown throws compute_children_active while a subagent is running,
    // but DO storage is wiped straight after destroy — the ledger row must not
    // survive the thread.
    const execShutdown = vi.fn().mockRejectedValue(new Error("compute_children_active"));
    const releaseQuotaSlot = vi.fn().mockResolvedValue(undefined);

    await teardownThreadBeforeDestroy({
      threadId: "thread_children",
      logPrefix: "think_thread",
      resolveComputeService: async () => ({ service: { execShutdown, releaseQuotaSlot } }),
    });

    expect(releaseQuotaSlot).toHaveBeenCalledOnce();
  });

  it("REGRESSION (I2): a failing quota release does not block destroy", async () => {
    const execShutdown = vi.fn().mockResolvedValue({ ok: true, terminated: true });
    const releaseQuotaSlot = vi.fn().mockRejectedValue(new Error("D1 down"));

    await expect(
      teardownThreadBeforeDestroy({
        threadId: "thread_quota_error",
        logPrefix: "thread",
        resolveComputeService: async () => ({ service: { execShutdown, releaseQuotaSlot } }),
      }),
    ).resolves.toBeUndefined();

    expect(releaseQuotaSlot).toHaveBeenCalledOnce();
  });

  it("cancels active subagents before shutting down compute", async () => {
    const events: string[] = [];

    await teardownThreadBeforeDestroy({
      threadId: "thread_subagents",
      logPrefix: "think_thread",
      cancelActiveSubagents: async () => {
        events.push("cancel_subagents");
      },
      resolveComputeService: async () => ({
        service: {
          execShutdown: async () => {
            events.push("exec_shutdown");
            return { ok: true, terminated: false, alreadyGone: true };
          },
        },
      }),
    });

    expect(events).toEqual(["cancel_subagents", "exec_shutdown"]);
  });
});
