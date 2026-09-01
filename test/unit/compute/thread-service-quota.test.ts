import { describe, expect, it, vi } from "vitest";
import { FakeComputeBackend } from "../../../src/compute/backends/fake";
import { ComputeError } from "../../../src/compute/errors";
import { DEFAULT_COMPUTE_LIMITS } from "../../../src/compute/config";
import { ThreadComputeService } from "../../../src/compute/thread-service";
import type { AgentSandboxGate } from "../../../src/compute/agent-sandbox-quota";
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

/** Records call order across every gate transition so ordering can be asserted. */
function makeQuotaSpy(overrides: Partial<AgentSandboxGate> = {}) {
  const calls: string[] = [];
  const gate: AgentSandboxGate = {
    admit: vi.fn(async () => {
      calls.push("admit");
      if (overrides.admit) await overrides.admit();
    }),
    recordRuntime: vi.fn(async (runtime) => {
      calls.push("recordRuntime");
      if (overrides.recordRuntime) await overrides.recordRuntime(runtime);
    }),
    refresh: vi.fn(async () => {
      calls.push("refresh");
      if (overrides.refresh) await overrides.refresh();
    }),
    idle: vi.fn(async () => {
      calls.push("idle");
      if (overrides.idle) await overrides.idle();
    }),
    forget: vi.fn(async () => {
      calls.push("forget");
      if (overrides.forget) await overrides.forget();
    }),
  };
  return { gate, calls };
}

function makeService(
  quota: AgentSandboxGate,
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

describe("ThreadComputeService wired to an AgentSandboxGate", () => {
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

  it("REGRESSION (Finding 1): forgets the row when a FRESH backend.acquire() throws after admit()", async () => {
    const { gate, calls } = makeQuotaSpy();
    const { service, backend } = makeService(gate);
    backend.failNextAcquire(new ComputeError("compute_unavailable", "boom"));

    await expect(service.exec({ command: "echo hi" })).rejects.toThrow();

    expect(gate.admit).toHaveBeenCalledTimes(1);
    expect(gate.forget).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["admit", "forget"]);
  });

  // The asymmetry that decides whether a transient wake failure costs a user
  // their filesystem: a RESTORE was waking a machine that still exists, so its
  // row must go back to `idle`. `forget` there would make the live, hibernated
  // sprite an orphan, and the reconciler would then delete it.
  it("REGRESSION: a failed RESTORE goes back to idle, never forget", async () => {
    const { gate, calls } = makeQuotaSpy();
    const { service, backend, clock } = makeService(gate);

    await service.exec({ command: "echo hi" });
    clock.now += CONFIG.idleTimeoutMs + 1;
    await service.runComputeTick();
    calls.length = 0;
    (gate.forget as ReturnType<typeof vi.fn>).mockClear();

    backend.failNextAcquire(new ComputeError("provider_transient", "wake failed"));
    await expect(service.exec({ command: "echo again" })).rejects.toThrow();

    expect(gate.forget).not.toHaveBeenCalled();
    expect(calls).toEqual(["admit", "idle"]);
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
    expect(gate.forget).not.toHaveBeenCalled();
    expect(backend.acquireCalls).toHaveLength(0);
    expect(calls).toEqual(["admit"]);
  });

  it("forgets the row on a confirmed exec_shutdown — the machine is destroyed", async () => {
    const { gate } = makeQuotaSpy();
    const { service } = makeService(gate);

    await service.exec({ command: "echo hi" });
    expect(gate.forget).not.toHaveBeenCalled();

    await service.execShutdown({ confirm: true });

    expect(gate.forget).toHaveBeenCalledTimes(1);
  });

  /**
   * REGRESSION: the confirmation gate used to fire only when processes were
   * RUNNING, which made the quiet box — the one with an accumulated
   * filesystem and nothing in flight — the case that got destroyed with no
   * prompt at all. Running processes are the recoverable loss; the agent's
   * disk, shared by every one of its threads, is not.
   */
  it("REGRESSION: an unconfirmed exec_shutdown on a QUIET box destroys nothing", async () => {
    const { gate } = makeQuotaSpy();
    const { service, backend, store } = makeService(gate);

    await service.exec({ command: "echo hi" });
    // Anti-vacuity: there is a live machine to lose, and nothing running.
    expect(store.getComputeState()?.status).toBe("active");
    expect(store.listProcesses(10).filter((p) => p.status === "running")).toHaveLength(0);

    const result = await service.execShutdown({});

    expect(result).toMatchObject({ terminated: false, needsConfirmation: true });
    expect(backend.destroyCalls).toHaveLength(0);
    expect(gate.forget).not.toHaveBeenCalled();
    expect(store.getComputeState()?.status).toBe("active");
  });

  // THE TASK-5 INVARIANT. An idle release is a hibernation, not a destruction:
  // dropping the row here would leave a live sprite with the agent's filesystem
  // on it and nothing accounting for it, which the reconciler then deletes.
  it("an idle release marks the row idle and NEVER forgets it", async () => {
    const { gate, calls } = makeQuotaSpy();
    const { service, store, clock } = makeService(gate);

    await service.exec({ command: "echo hi" });
    clock.now += CONFIG.idleTimeoutMs + 1;
    await service.runComputeTick();

    expect(store.getComputeState()?.status).toBe("recoverable");
    expect(gate.idle).toHaveBeenCalledTimes(1);
    expect(gate.forget).not.toHaveBeenCalled();
    expect(calls).toContain("idle");
  });

  // The old TTL destroy lived here. Nothing may ever destroy on a timer again.
  it("REGRESSION: a recoverable box is never destroyed however long it sits", async () => {
    const { gate } = makeQuotaSpy();
    const { service, backend, store, clock } = makeService(gate);

    await service.exec({ command: "echo hi" });
    clock.now += CONFIG.idleTimeoutMs + 1;
    await service.runComputeTick();
    expect(store.getComputeState()?.status).toBe("recoverable");

    const destroysAfterRelease = backend.destroyCalls.length;
    clock.now += CONFIG.recoveryTtlMs * 1000;
    await service.runComputeTick();
    await service.runComputeTick();

    expect(backend.destroyCalls).toHaveLength(destroysAfterRelease);
    expect(store.getComputeState()?.status).toBe("recoverable");
    expect(gate.forget).not.toHaveBeenCalled();
  });

  it("records the machine name immediately after the provider answers", async () => {
    const { gate, calls } = makeQuotaSpy();
    const { service } = makeService(gate);

    await service.exec({ command: "echo hi" });

    expect(gate.recordRuntime).toHaveBeenCalledTimes(1);
    expect(calls.indexOf("recordRuntime")).toBe(calls.indexOf("admit") + 1);
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
    expect(gate.idle).not.toHaveBeenCalled();
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

  it("REGRESSION (I1): forgets the row when the backend reports the runtime is gone", async () => {
    const { gate } = makeQuotaSpy();
    const { service, backend, store } = makeService(gate);

    await service.exec({ command: "echo hi" });
    const runtime = store.getComputeState()?.runtimeRef;
    expect(runtime).toBeTruthy();

    // The container disappears behind our back; the next exec observes it.
    await backend.destroy(runtime!);
    await service.exec({ command: "echo again" }); // markRuntimeMissing, then re-acquire

    expect(gate.forget).toHaveBeenCalledTimes(1);
    // Re-acquired after the loss: admit ran again (once per acquisition).
    expect(gate.admit).toHaveBeenCalledTimes(2);
  });
});
