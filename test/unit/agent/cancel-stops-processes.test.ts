import { describe, expect, it, vi } from "vitest";
import { ThinkThreadAgent } from "../../../src/agent/think-thread-agent";

/**
 * The AGENT WIRING for "stop means stop".
 *
 * `thread-service.test.ts` proves `stopAllRunningProcesses` kills processes and
 * drops their watchers. It would not notice if nothing ever CALLED it — and for
 * a long time nothing did: the UI stop button aborted the model turn while every
 * process the model had launched kept running in the container until it exited
 * or hit maxProcessRuntimeMs.
 *
 * Worse, the turn-end hook ran `autoWatchRunningProcesses()` on the cancelled
 * turn too, re-attaching a watcher to the very process the user asked to stop and
 * later reporting its completion. These tests call the real `onChatResponse` on
 * the real prototype and pin both branches.
 */

vi.mock("../../../src/db/client", () => ({ registryDb: () => ({}) }));

const resolved = vi.hoisted(() => ({
  service: null as unknown as {
    stopAllRunningProcesses: ReturnType<typeof vi.fn>;
    autoWatchRunningProcesses: ReturnType<typeof vi.fn>;
  },
}));

// Fully replaced, never importOriginal: the real module pulls in `cloudflare:`
// imports the node ESM loader cannot resolve.
vi.mock("../../../src/agent/compute-tools", () => ({
  resolveComputeService: async () => ({ service: resolved.service }),
  createComputeTools: () => ({}),
  scheduleComputeEviction: async () => undefined,
  cancelComputeEviction: async () => undefined,
}));

function makeService() {
  return {
    stopAllRunningProcesses: vi.fn(async () => ({ stopped: ["proc_1"], failed: [] })),
    autoWatchRunningProcesses: vi.fn(async () => undefined),
  };
}

/** The narrowest `this` that gets `onChatResponse` through to the compute branch. */
function makeAgent() {
  return {
    name: "thr_test",
    env: {},
    currentTurnStartedAt: Date.now(),
    flushTurnUsage: vi.fn(async () => undefined),
    processMonitorEnabled: () => true,
    // The turn-end stop/watch branch opens a session on the sandbox DO.
    openSandbox: async () => ({ service: resolved.service }),
    _turnSandbox: null,
    injectionBuffer: () => ({ isEmpty: () => true }),
    // Read once at turn end for the approval probe and the push preview.
    getMessages: vi.fn(async () => []),
    turnHasPendingApproval: vi.fn(async () => false),
    // No runtime config -> the notification/lifecycle tail short-circuits.
    resolveRuntimeConfigForThink: vi.fn(async () => null),
    takeAutomatonRunOutcome: vi.fn(async () => null),
  };
}

const onChatResponse = ThinkThreadAgent.prototype.onChatResponse as (
  this: unknown,
  result?: { status: string },
) => Promise<void>;

describe("cancelled turn stops the sandbox", () => {
  it("kills the thread's running processes when the turn is aborted", async () => {
    resolved.service = makeService();
    const agent = makeAgent();

    await onChatResponse.call(agent, { status: "aborted" });

    expect(resolved.service.stopAllRunningProcesses).toHaveBeenCalledTimes(1);
    // Watching a process we just killed would report its "completion" later.
    expect(resolved.service.autoWatchRunningProcesses).not.toHaveBeenCalled();
  });

  it("still watches (does not kill) when the turn completes normally", async () => {
    resolved.service = makeService();
    const agent = makeAgent();

    await onChatResponse.call(agent, { status: "completed" });

    expect(resolved.service.autoWatchRunningProcesses).toHaveBeenCalledTimes(1);
    expect(resolved.service.stopAllRunningProcesses).not.toHaveBeenCalled();
  });

  // SubAgent sets processMonitorEnabled() false — that flag is about WATCHER
  // support, and gating the kill on it would let a cancelled subagent leave its
  // processes running.
  it("stops processes on cancel even when the process monitor is disabled", async () => {
    resolved.service = makeService();
    const agent = { ...makeAgent(), processMonitorEnabled: () => false };

    await onChatResponse.call(agent, { status: "aborted" });

    expect(resolved.service.stopAllRunningProcesses).toHaveBeenCalledTimes(1);
  });

  it("does not stop anything when a monitorless turn completes normally", async () => {
    resolved.service = makeService();
    const agent = { ...makeAgent(), processMonitorEnabled: () => false };

    await onChatResponse.call(agent, { status: "completed" });

    expect(resolved.service.stopAllRunningProcesses).not.toHaveBeenCalled();
    expect(resolved.service.autoWatchRunningProcesses).not.toHaveBeenCalled();
  });

  // Think also routes `completed` turns here with no result in some paths; a
  // missing status must never be read as a cancellation.
  it("treats a missing result as not-cancelled", async () => {
    resolved.service = makeService();
    const agent = makeAgent();

    await onChatResponse.call(agent);

    expect(resolved.service.stopAllRunningProcesses).not.toHaveBeenCalled();
    expect(resolved.service.autoWatchRunningProcesses).toHaveBeenCalledTimes(1);
  });
});
