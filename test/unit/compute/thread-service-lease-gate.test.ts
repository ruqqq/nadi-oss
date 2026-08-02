import { describe, expect, it } from "vitest";
import { FakeComputeBackend } from "../../../src/compute/backends/fake";
import { DEFAULT_COMPUTE_LIMITS } from "../../../src/compute/config";
import { ThreadComputeService } from "../../../src/compute/thread-service";
import type { ThreadComputeStoreLike } from "../../../src/compute/thread-service";
import type { ComputeState } from "../../../src/compute/thread-store";

function createLifecycleStore(): ThreadComputeStoreLike {
  let state: ComputeState | null = null;
  const processes = new Map<string, any>();
  const base = (now: number): ComputeState =>
    state ?? {
      id: "thread",
      status: "absent",
      provider: null,
      providerConfig: null,
      acquiredAllowedHosts: undefined,
      runtimeRef: null,
      recoveryRef: null,
      resourceProfile: "small",
      createdAt: now,
      lastUsedAt: now,
      releaseAt: null,
      recoveredAt: null,
      recoveryExpiresAt: null,
      errorCode: null,
      errorDetail: null,
      releaseReason: null,
      generation: null,
      generationAbsentAt: null,
    };
  return {
    getComputeState: () => state,
    markAcquiring: ({ provider, resourceProfile, now }) =>
      void (state = {
        ...base(now),
        status: "acquiring",
        provider,
        providerConfig: state?.providerConfig ?? null,
        resourceProfile,
        generation: null,
      }),
    markActive: (runtimeRef, now) =>
      void (state = {
        ...base(now),
        status: "active",
        provider: runtimeRef.provider,
        providerConfig: state?.providerConfig ?? null,
        runtimeRef,
        recoveryRef: null,
        lastUsedAt: now,
      }),
    markReleasing: (now) =>
      void (state = state && { ...state, status: "releasing", releaseAt: now }),
    markRecoverable: (recoveryRef, now, recoveryExpiresAt) =>
      void (state = {
        ...base(now),
        status: "recoverable",
        provider: recoveryRef.provider,
        providerConfig: state?.providerConfig ?? null,
        runtimeRef: null,
        recoveryRef,
        recoveryExpiresAt,
      }),
    markDiscarding: (now) =>
      void (state = state && {
        ...state,
        status: "discarding",
        releaseAt: now,
        generation: null,
      }),
    markAbsent: (now) =>
      void (state = {
        ...base(now),
        status: "absent",
        provider: null,
        providerConfig: null,
        runtimeRef: null,
        recoveryRef: null,
        generation: null,
      }),
    touchLastUsed: (now) => void (state = state && { ...state, lastUsedAt: now }),
    setResourceProfile: (resourceProfile, now) => void (state = { ...base(now), resourceProfile }),
    markError: ({ code, detail }, now) =>
      void (state = { ...base(now), status: "error", errorCode: code, errorDetail: detail }),
    setGeneration: (generation, now) =>
      void (state = {
        ...base(now),
        generation: generation.kind === "known" ? generation.nonce : null,
        generationAbsentAt: generation.kind === "absent" ? generation.observedAt : null,
      }),
    createProcess: (process) => void processes.set(process.id, process),
    updateProcess: (id, patch) => void Object.assign(processes.get(id), patch),
    listProcesses: (limit) => [...processes.values()].slice(0, limit),
    getProcess: (id) => processes.get(id) ?? null,
    appendOutput: () => {},
    listOutputChunks: () => [],
    upsertWatcher: () => {},
    deleteWatcher: () => {},
    listWatchers: () => [],
    countWatchers: () => 0,
    markProcessAutoWatched: () => {},
    wasProcessAutoWatched: () => false,
  };
}

function setup() {
  const backend = new FakeComputeBackend();
  const store = createLifecycleStore();
  const now = { value: 1_000 };
  let blocked = true;
  const alarms: number[] = [];
  const service = new ThreadComputeService({
    backend,
    store,
    config: {
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
      environmentEditableEnv: {},
      environmentSecretEnvNames: [],
    },
    environmentId: "lease_test",
    env: {},
    setAlarm: async (timestamp) => void alarms.push(timestamp),
    now: () => now.value,
    hasBlockingWork: async () => blocked,
  });
  return { service, backend, store, now, alarms, unblock: () => void (blocked = false) };
}

describe("ThreadComputeService lease gate", () => {
  it("defers release while child work is active, then releases when it clears", async () => {
    const { service, backend, store, now, alarms, unblock } = setup();
    await service.exec({ command: "pwd" });
    now.value = 2_000;

    await service.runComputeTick();
    expect(backend.releaseCalls).toHaveLength(0);
    expect(store.getComputeState()?.status).toBe("active");
    expect(alarms.at(-1)).toBe(3_000);

    unblock();
    await service.runComputeTick();
    expect(backend.releaseCalls).toHaveLength(1);
  });

  it("refuses explicit shutdown while child work is active", async () => {
    const { service } = setup();
    await service.exec({ command: "pwd" });

    await expect(service.execShutdown({ confirm: true })).rejects.toThrow(
      "compute_children_active",
    );
  });
});
