import { describe, expect, it, vi } from "vitest";
import { FakeComputeBackend } from "../../../src/compute/backends/fake";
import { DEFAULT_COMPUTE_LIMITS } from "../../../src/compute/config";
import {
  RECLAIM_MIN_IDLE_MS,
  type AgentSandboxGate,
} from "../../../src/compute/agent-sandbox-quota";
import { ThreadComputeService } from "../../../src/compute/thread-service";
import type { EffectiveComputeConfig } from "../../../src/compute/types";
import { createMemoryComputeStore } from "./helpers/memory-store";

const CONFIG: EffectiveComputeConfig = {
  provider: "fake",
  providerConfig: { kind: "cloudflare" },
  resourceProfile: "small",
  idleTimeoutMs: 1_000,
  recoveryTtlMs: 5_000,
  maxProcessRuntimeMs: 10_000,
  monitorPollIntervalMs: 100,
  limits: DEFAULT_COMPUTE_LIMITS,
  allowedHosts: null,
  editableEnv: {},
  agentEditableEnv: {},
  secretEnvNames: [],
};

function makeService(input?: {
  attachedRuntime?: Awaited<ReturnType<FakeComputeBackend["acquire"]>>;
  quota?: AgentSandboxGate;
}) {
  const backend = new FakeComputeBackend();
  const store = createMemoryComputeStore();
  const clock = { now: 1_000 };
  const service = new ThreadComputeService({
    backend,
    store,
    config: CONFIG,
    environmentId: "thread_test",
    threadId: "thr_release_if_reclaimable",
    env: {},
    setAlarm: async () => {},
    now: () => clock.now,
    ...(input?.attachedRuntime ? { attachedRuntime: input.attachedRuntime } : {}),
    ...(input?.quota ? { quota: input.quota } : {}),
  });
  const goIdle = () => {
    clock.now += RECLAIM_MIN_IDLE_MS;
  };
  return { service, backend, store, clock, goIdle };
}

describe("releaseIfReclaimable", () => {
  it("returns false when there is no active container", async () => {
    const { service } = makeService();
    expect(await service.releaseIfReclaimable()).toBe(false);
  });

  it("refuses while a process is running", async () => {
    const { service, goIdle } = makeService();
    await service.execStart({ command: "sleep 100" });
    goIdle();
    expect(await service.releaseIfReclaimable()).toBe(false);
  });

  it("releases an idle container and reports true", async () => {
    const { service, store, goIdle } = makeService();
    await service.exec({ command: "echo hi" }); // acquires, then finishes
    goIdle();
    expect(await service.releaseIfReclaimable()).toBe(true);
    expect(store.getComputeState()?.status).not.toBe("active");
  });

  it("refuses when a subagent is attached to this runtime", async () => {
    const { service } = makeService({
      attachedRuntime: { provider: "fake", version: 1, payload: {} },
    });
    expect(await service.releaseIfReclaimable()).toBe(false);
  });

  it("REGRESSION (C1): never discards an ephemeral container — always the recoverable path", async () => {
    const { service, backend, store, goIdle } = makeService();
    await service.exec({ command: "echo hi" });
    goIdle();

    expect(await service.releaseIfReclaimable()).toBe(true);

    // Retention is ephemeral, yet the reclaim must NOT destroy the container:
    // uncommitted work in /workspace has to survive.
    expect(backend.releaseCalls.map((c) => c.options.disposition)).toEqual(["recoverable"]);
    expect(store.getComputeState()?.status).toBe("recoverable");
    expect(store.getComputeState()?.recoveryRef).toBeTruthy();
  });

  it("REGRESSION (C1): refuses a container used within the idle grace period", async () => {
    const { service, backend, store, clock } = makeService();
    await service.exec({ command: "echo hi" });
    clock.now += RECLAIM_MIN_IDLE_MS - 1;

    // LRU order does not imply idle: this thread may be mid-turn.
    expect(await service.releaseIfReclaimable()).toBe(false);
    expect(backend.releaseCalls).toHaveLength(0);
    expect(store.getComputeState()?.status).toBe("active");
  });

  it("REGRESSION (C1): rolls back to active (never discards) when the recoverable release fails", async () => {
    const idle = vi.fn(async () => {});
    const quota: AgentSandboxGate = {
      admit: async () => {},
      recordRuntime: async () => {},
      refresh: async () => {},
      idle,
      forget: async () => {},
    };
    const { service, backend, store, goIdle } = makeService({ quota });
    await service.exec({ command: "echo hi" });
    goIdle();
    backend.failNextRelease(new Error("provider down"));

    expect(await service.releaseIfReclaimable()).toBe(false);
    expect(store.getComputeState()?.status).toBe("active");
    expect(backend.destroyCalls).toHaveLength(0);
    expect(idle).not.toHaveBeenCalled();
  });

  it("REGRESSION (N1): keeps the backup reachable when a step AFTER a successful backup fails", async () => {
    // The backup was written and the container destroyed; the ledger delete then
    // fails. Rolling back to `active` here would null recoveryRef and strand the
    // ONLY reference to the user's uncommitted /workspace work.
    const quota: AgentSandboxGate = {
      admit: async () => {},
      recordRuntime: async () => {},
      refresh: async () => {},
      idle: async () => {
        throw new Error("d1 unavailable");
      },
      forget: async () => {},
    };
    const { service, backend, store, goIdle } = makeService({ quota });
    await service.exec({ command: "echo hi" });
    goIdle();

    await service.releaseIfReclaimable();

    expect(backend.releaseCalls.map((c) => c.options.disposition)).toEqual(["recoverable"]);
    const state = store.getComputeState();
    expect(state?.status).toBe("recoverable");
    expect(state?.recoveryRef).toBeTruthy();
  });
});
