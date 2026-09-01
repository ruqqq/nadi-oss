import { describe, expect, it, vi } from "vitest";
import { teardownThreadBeforeDestroy } from "../../../src/agent/thread-destroy-teardown";

describe("teardownThreadBeforeDestroy", () => {
  it("cancels the thread's active subagents", async () => {
    const cancelActiveSubagents = vi.fn();

    await expect(
      teardownThreadBeforeDestroy({
        threadId: "thread_subagents",
        logPrefix: "think_thread",
        cancelActiveSubagents,
      }),
    ).resolves.toBeUndefined();

    expect(cancelActiveSubagents).toHaveBeenCalledOnce();
  });

  it("does not block destroy when cancelling subagents throws", async () => {
    await expect(
      teardownThreadBeforeDestroy({
        threadId: "thread_error",
        logPrefix: "thread",
        cancelActiveSubagents: async () => {
          throw new Error("facet unreachable");
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("is a no-op with nothing to cancel", async () => {
    await expect(
      teardownThreadBeforeDestroy({ threadId: "thread_none", logPrefix: "thread" }),
    ).resolves.toBeUndefined();
  });

  /**
   * REGRESSION (P3): destroying ONE thread must not touch the agent's machine.
   *
   * This used to call `execShutdown({ confirm: true })` and then drop the quota
   * row. That was right while the box was keyed by thread. Since the DO is keyed
   * by AGENT, the same two calls destroy the shared sprite — every sibling
   * thread's worktree, the canonical clones, the installed tooling — on the
   * archive of one chat.
   *
   * The guard is structural: the module no longer has a way to reach compute at
   * all. Asserting the surface is what catches a reintroduction, since a
   * reintroduced call would compile and no existing test would fail.
   */
  it("REGRESSION: reads no compute dep off its input at all", async () => {
    const reads: string[] = [];
    const deps = new Proxy(
      {
        threadId: "thread_shared_box",
        logPrefix: "think_thread",
        cancelActiveSubagents: async () => {},
      } as Record<string, unknown>,
      {
        get(target, prop) {
          if (typeof prop !== "string") return undefined;
          reads.push(prop);
          return target[prop];
        },
      },
    );

    await teardownThreadBeforeDestroy(deps as never);

    // Anything compute-shaped read here is a route back to the AGENT's machine.
    expect(reads.filter((name) => /compute|sandbox|shutdown|quota/i.test(name))).toEqual([]);
    expect(reads).toContain("cancelActiveSubagents");
  });
});
