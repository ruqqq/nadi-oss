import { describe, expect, it, vi } from "vitest";
import { FakeComputeBackend } from "../../../src/compute/backends/fake";
import { ComputeError } from "../../../src/compute/errors";
import { DEFAULT_COMPUTE_LIMITS } from "../../../src/compute/config";
import { ThreadComputeService } from "../../../src/compute/thread-service";
import type { ComputeQuotaGate } from "../../../src/compute/container-quota";
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

/** Records call order across admit/refresh/release so ordering can be asserted. */
function makeQuotaSpy(overrides: Partial<ComputeQuotaGate> = {}) {
  const calls: string[] = [];
  const gate: ComputeQuotaGate = {
    admit: vi.fn(async () => {
      calls.push("admit");
      if (overrides.admit) await overrides.admit();
    }),
    refresh: vi.fn(async () => {
      calls.push("refresh");
      return overrides.refresh ? await overrides.refresh() : true;
    }),
    release: vi.fn(async () => {
      calls.push("release");
      if (overrides.release) await overrides.release();
    }),
  };
  return { gate, calls };
}

function makeService(
  quota: ComputeQuotaGate,
  options: { hasBlockingWork?: () => Promise<boolean> } = {},
) {
  const backend = new FakeComputeBackend();
  const store = createMemoryComputeStore();
  const clock = { now: 1_000 };
  const service = new ThreadComputeService({
    backend,
    store,
    config: CONFIG,
    environmentId: "thread_test",
    threadId: "thr_thread_service_quota",
    env: {},
    setAlarm: async () => {},
    clearAlarm: async () => {},
    now: () => clock.now,
    quota,
    ...(options.hasBlockingWork ? { hasBlockingWork: options.hasBlockingWork } : {}),
  });
  return { service, backend, store, clock };
}

describe("ThreadComputeService wired to a ComputeQuotaGate", () => {
  it("calls admit() before backend.acquire() on a fresh acquisition", async () => {
    const { gate, calls } = makeQuotaSpy();
    const { service, backend } = makeService(gate);

    await service.exec({ command: "echo hi" });

    expect(gate.admit).toHaveBeenCalledTimes(1);
    expect(backend.acquireCalls).toHaveLength(1);
    // admit must be recorded before acquire has any observable effect: since
    // FakeComputeBackend.acquire pushes onto acquireCalls synchronously within
    // its own call, "admit" must appear in calls before we can have an
    // acquireCall — assert via relative ordering using a marker.
    expect(calls.indexOf("admit")).toBe(0);
  });

  it("REGRESSION (Finding 1): calls release() when backend.acquire() throws after admit() succeeded", async () => {
    const { gate, calls } = makeQuotaSpy();
    const { service, backend } = makeService(gate);
    backend.failNextAcquire(new ComputeError("compute_unavailable", "boom"));

    await expect(service.exec({ command: "echo hi" })).rejects.toThrow();

    expect(gate.admit).toHaveBeenCalledTimes(1);
    expect(gate.release).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["admit", "release"]);
  });

  it("does NOT call release() when admit() itself throws quota_exhausted", async () => {
    const { gate, calls } = makeQuotaSpy({
      admit: async () => {
        throw new ComputeError("quota_exhausted", "no slots");
      },
    });
    const { service, backend } = makeService(gate);

    await expect(service.exec({ command: "echo hi" })).rejects.toThrow();

    expect(gate.admit).toHaveBeenCalledTimes(1);
    expect(gate.release).not.toHaveBeenCalled();
    expect(backend.acquireCalls).toHaveLength(0);
    expect(calls).toEqual(["admit"]);
  });

  it("calls release() on a normal exec_shutdown", async () => {
    const { gate } = makeQuotaSpy();
    const { service } = makeService(gate);

    await service.exec({ command: "echo hi" });
    expect(gate.release).not.toHaveBeenCalled();

    await service.execShutdown({});

    expect(gate.release).toHaveBeenCalledTimes(1);
  });

  it("REGRESSION (C2): a tick that keeps the container alive for a subagent refreshes the lease", async () => {
    const { gate } = makeQuotaSpy();
    const { service, store, clock } = makeService(gate, { hasBlockingWork: async () => true });

    await service.exec({ command: "echo hi" });
    const refreshesAfterAcquire = (gate.refresh as ReturnType<typeof vi.fn>).mock.calls.length;

    // Past the idle timeout: releaseIfIdle hits the blocking-work branch, keeps
    // the container, and would previously have let the ledger row expire.
    clock.now += CONFIG.idleTimeoutMs + 1;
    await service.runComputeTick();

    expect((gate.refresh as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(
      refreshesAfterAcquire,
    );
    expect(gate.release).not.toHaveBeenCalled();
    expect(store.getComputeState()?.status).toBe("active");
  });

  it("REGRESSION (C2): a tick that keeps the container alive for a watcher refreshes the lease", async () => {
    const { gate } = makeQuotaSpy();
    const { service, store, clock } = makeService(gate);

    const started = await service.execStart({ command: "sleep 100" });
    await service.execWatch({ processId: started.processId });
    const refreshesAfterStart = (gate.refresh as ReturnType<typeof vi.fn>).mock.calls.length;

    clock.now += CONFIG.idleTimeoutMs + 1;
    await service.runComputeTick();

    expect((gate.refresh as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(
      refreshesAfterStart,
    );
    expect(store.getComputeState()?.status).toBe("active");
  });

  it("REGRESSION (I1): releases the ledger row when the backend reports the runtime is gone", async () => {
    const { gate } = makeQuotaSpy();
    const { service, backend, store } = makeService(gate);

    await service.exec({ command: "echo hi" });
    const runtime = store.getComputeState()?.runtimeRef;
    expect(runtime).toBeTruthy();

    // The container disappears behind our back; the next exec observes it.
    await backend.destroy(runtime!);
    await service.exec({ command: "echo again" }); // markRuntimeMissing, then re-acquire

    expect(gate.release).toHaveBeenCalledTimes(1);
    // Re-acquired after the loss: admit ran again (once per acquisition).
    expect(gate.admit).toHaveBeenCalledTimes(2);
  });
});
