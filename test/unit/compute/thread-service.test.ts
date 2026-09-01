import { describe, expect, it, vi } from "vitest";
import { FakeComputeBackend } from "../../../src/compute/backends/fake";
import { DEFAULT_COMPUTE_LIMITS } from "../../../src/compute/config";
import { ComputeError } from "../../../src/compute/errors";
import { log } from "../../../src/log";
import {
  ThreadComputeService,
  type ThreadComputeStoreLike,
} from "../../../src/compute/thread-service";
import type { EffectiveComputeConfig } from "../../../src/compute/types";
import type { ComputeProcessRecord, ThreadComputeStore } from "../../../src/compute/thread-store";
import type { WorkspaceCleanliness } from "../../../src/compute/workspace-cleanliness";
import { createMemoryComputeStore } from "./helpers/memory-store";
import { threadWorkRoot } from "../../../src/compute/workspace-layout";

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

/**
 * A stated `dirty` input for the tests below whose subject is the RECOVERY
 * lifecycle, not the retention decision. They need `releaseIfIdle` to preserve;
 * leaving the probe dep absent would obtain that from `resolveIdleDisposition`'s
 * absent-probe DEFAULT instead, so mutating that one default would break every
 * one of them at once and hide which behavior actually regressed. The one test
 * whose subject IS that default ("preserves when no probe dep is wired at all")
 * deliberately passes nothing.
 */
const dirtyProbe = (): (() => Promise<WorkspaceCleanliness>) => async () => ({
  state: "dirty",
  repos: [{ path: "/workspace/app", changes: [" M src/a.ts"], unpushed: 0 }],
});

// Tracks each created service's mutable clock so `makeIdle` can advance it
// from just a `ThreadComputeService` reference, matching the brief's test
// shape (`createService` returns `{ service, backend }` with `now` unused).
const serviceClocks = new WeakMap<ThreadComputeService, { value: number }>();

function createService(input?: {
  now?: { value: number };
  backend?: FakeComputeBackend;
  store?: ThreadComputeStoreLike;
  alarms?: number[];
  markSandboxDirty?: () => Promise<void>;
  isSandboxDeclaredClean?: () => Promise<boolean>;
  probeWorkspaceCleanliness?: () => Promise<WorkspaceCleanliness>;
  config?: EffectiveComputeConfig;
  onFreshRuntimeAcquired?: () => Promise<void>;
  backgroundLongRunningExec?: boolean;
  supportsProcessMonitor?: boolean;
  execForegroundTimeoutMs?: number;
  execForegroundPollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}) {
  const backend = input?.backend ?? new FakeComputeBackend();
  const store = input?.store ?? createMemoryComputeStore();
  const now = input?.now ?? { value: 1_000 };
  const alarms = input?.alarms ?? [];
  const service = new ThreadComputeService({
    backend,
    store,
    config: input?.config ?? CONFIG,
    environmentId: "thread_test",
    threadId: "thread_test",
    env: {},
    setAlarm: async (timestamp) => void alarms.push(timestamp),
    now: () => now.value,
    ...(input?.markSandboxDirty ? { markSandboxDirty: input.markSandboxDirty } : {}),
    ...(input?.isSandboxDeclaredClean
      ? { isSandboxDeclaredClean: input.isSandboxDeclaredClean }
      : {}),
    ...(input?.probeWorkspaceCleanliness
      ? { probeWorkspaceCleanliness: input.probeWorkspaceCleanliness }
      : {}),
    ...(input?.onFreshRuntimeAcquired
      ? { onFreshRuntimeAcquired: input.onFreshRuntimeAcquired }
      : {}),
    ...(input?.backgroundLongRunningExec === undefined
      ? {}
      : { backgroundLongRunningExec: input.backgroundLongRunningExec }),
    ...(input?.supportsProcessMonitor === undefined
      ? {}
      : { supportsProcessMonitor: input.supportsProcessMonitor }),
    ...(input?.execForegroundTimeoutMs === undefined
      ? {}
      : { execForegroundTimeoutMs: input.execForegroundTimeoutMs }),
    ...(input?.execForegroundPollIntervalMs === undefined
      ? {}
      : { execForegroundPollIntervalMs: input.execForegroundPollIntervalMs }),
    ...(input?.sleep ? { sleep: input.sleep } : {}),
  });
  serviceClocks.set(service, now);
  return { service, backend, store, now, alarms };
}

/**
 * Acquires compute (so there's a runtime to release) and advances the
 * service's own clock past `idleTimeoutMs`, the same way the file's existing
 * idle tests do by hand (`now.value = 2_000; await service.runComputeTick()`)
 * — except here the clock is looked up from `service` itself so callers only
 * need the service reference, matching the retention-decision tests below.
 */
async function makeIdle(service: ThreadComputeService): Promise<void> {
  await service.exec({ command: "pwd" });
  const clock = serviceClocks.get(service);
  if (!clock) throw new Error("makeIdle: service was not built by this file's createService");
  clock.value += CONFIG.idleTimeoutMs;
}

describe("ThreadComputeService lifecycle", () => {
  it("accepts the concrete thread compute store contract", () => {
    const concreteStore: ThreadComputeStoreLike = null as unknown as ThreadComputeStore;
    expect(concreteStore).toBeNull();
  });

  it("lazily acquires compute and discards compute proven clean after the idle timeout", async () => {
    // Retention no longer decides the disposition (Task 4) — proof does. A
    // clean probe is the proof supplied here so this test still exercises the
    // discard path; see the "retention: preserve by default" describe block
    // below for the full disposition matrix.
    const { service, backend, store, now } = createService({
      probeWorkspaceCleanliness: async () => ({ state: "clean" }),
    });

    await service.exec({ command: "pwd" });
    expect(store.getComputeState()?.status).toBe("active");

    now.value = 2_000;
    await service.runComputeTick();

    expect(backend.releaseCalls).toMatchObject([{ options: { disposition: "discard" } }]);
    expect(store.getComputeState()?.status).toBe("absent");
  });

  it("defaults exec to THIS thread's working directory, and an explicit cwd still wins", async () => {
    const { service, backend } = createService();

    // No cwd: a relative path must resolve under the same root the file tools
    // guard, and since P3 that root is the thread's own directory inside the
    // AGENT's shared box — not `/workspace`, which every thread shares, and not
    // the sandbox's boot dir (/root).
    await service.exec({ command: "pwd" });
    expect(backend.startProcessCalls.at(-1)).toMatchObject({
      command: "pwd",
      cwd: threadWorkRoot("thread_test"),
    });
    expect(backend.startProcessCalls.at(-1)?.cwd).not.toBe("/workspace");

    // An explicit cwd is honored unchanged.
    await service.exec({ command: "pwd", cwd: "/workspace/nadi" });
    expect(backend.startProcessCalls.at(-1)).toMatchObject({ cwd: "/workspace/nadi" });
  });

  it("releases repository work as recoverable and stops running process records", async () => {
    const { service, backend, store, now } = createService({
      probeWorkspaceCleanliness: dirtyProbe(),
    });
    const started = await service.execStart({ command: "sleep 30" });

    now.value = 2_000;
    await service.runComputeTick();

    expect(backend.releaseCalls).toMatchObject([
      { options: { disposition: "recoverable", recoveryTtlMs: 5_000 } },
    ]);
    expect(store.getComputeState()).toMatchObject({
      status: "recoverable",
      recoveryExpiresAt: 7_000,
    });
    expect(store.getProcess(started.processId)).toMatchObject({ status: "stopped" });
  });

  it("restores recoverable compute without assuming old processes survived", async () => {
    const { service, backend, store, now } = createService({
      probeWorkspaceCleanliness: dirtyProbe(),
    });
    const started = await service.execStart({ command: "sleep 30" });
    now.value = 2_000;
    await service.runComputeTick();

    now.value = 2_500;
    await service.exec({ command: "pwd" });

    expect(backend.acquireCalls[1]?.recovery).toEqual(backend.releaseCalls[0]?.recovery);
    expect(store.getComputeState()?.status).toBe("active");
    expect(store.getProcess(started.processId)?.status).toBe("stopped");
  });

  it("keeps recoverable compute dormant when a turn starts before expiry", async () => {
    const { service, backend, store, now } = createService({
      probeWorkspaceCleanliness: dirtyProbe(),
    });
    await service.exec({ command: "pwd" });
    now.value = 2_000;
    await service.runComputeTick();
    expect(store.getComputeState()?.status).toBe("recoverable");
    const acquiresBefore = backend.acquireCalls.length;

    now.value = 2_500;
    await service.cleanupExpiredRecoverableCompute();

    expect(backend.acquireCalls).toHaveLength(acquiresBefore);
    expect(store.getComputeState()?.status).toBe("recoverable");
  });

  it("prepares repositories on a genuinely fresh runtime", async () => {
    const onFreshRuntimeAcquired = vi.fn().mockResolvedValue(undefined);
    const { service } = createService({ onFreshRuntimeAcquired });
    await service.exec({ command: "true" });
    expect(onFreshRuntimeAcquired).toHaveBeenCalledOnce();
  });

  it("does NOT prepare repositories when resuming from recovery", async () => {
    // A recovery restore returns /workspace from backup. Re-cloning would
    // clobber restored work. Seed recoverable state the same way the
    // "restores recoverable compute" test does — a real exec + runComputeTick
    // — rather than hand-crafting a store row, so the fake backend's own
    // suspended-runtime bookkeeping is exercised too.
    const onFreshRuntimeAcquired = vi.fn().mockResolvedValue(undefined);
    const { service, now } = createService({
      onFreshRuntimeAcquired,
      probeWorkspaceCleanliness: dirtyProbe(),
    });
    await service.exec({ command: "pwd" });
    now.value = 2_000;
    await service.runComputeTick();
    onFreshRuntimeAcquired.mockClear();

    now.value = 2_500;
    await service.exec({ command: "true" });
    expect(onFreshRuntimeAcquired).not.toHaveBeenCalled();
  });

  it("does not fail acquisition when repository preparation throws", async () => {
    const onFreshRuntimeAcquired = vi.fn().mockRejectedValue(new Error("clone failed"));
    const { service, store } = createService({ onFreshRuntimeAcquired });
    await expect(service.exec({ command: "true" })).resolves.toMatchObject({ status: "exited" });
    expect(store.getComputeState()?.status).toBe("active");
  });

  it("keeps the runtime active when recoverable release fails", async () => {
    const { service, backend, store, now } = createService({
      probeWorkspaceCleanliness: dirtyProbe(),
    });
    await service.exec({ command: "pwd" });
    backend.failNextRelease(new ComputeError("provider_transient"));
    now.value = 2_000;

    await service.runComputeTick();

    expect(store.getComputeState()?.status).toBe("active");
    expect(backend.destroyCalls).toHaveLength(0);
  });

  it("retains recovery state when reacquisition fails", async () => {
    const { service, backend, store, now } = createService({
      probeWorkspaceCleanliness: dirtyProbe(),
    });
    await service.exec({ command: "pwd" });
    now.value = 2_000;
    await service.runComputeTick();
    backend.failNextAcquire(new ComputeError("recovery_failed"));

    await expect(service.exec({ command: "pwd" })).rejects.toMatchObject({
      code: "recovery_failed",
    });
    expect(store.getComputeState()?.status).toBe("recoverable");
  });

  it("destroys expired recovery state and clears the declared-clean bit", async () => {
    const dirtyCalls: number[] = [];
    const { service, backend, store, now } = createService({
      markSandboxDirty: async () => void dirtyCalls.push(1),
      probeWorkspaceCleanliness: dirtyProbe(),
    });
    await service.exec({ command: "pwd" });
    now.value = 2_000;
    await service.runComputeTick();

    now.value = 7_000;
    await service.runComputeTick();

    expect(backend.destroyCalls).toHaveLength(1);
    expect(store.getComputeState()?.status).toBe("absent");
    expect(dirtyCalls.length).toBeGreaterThan(0);
  });

  it("does not provision fresh compute on a bare turn once recovery has expired", async () => {
    const { service, backend, store, now } = createService({
      probeWorkspaceCleanliness: dirtyProbe(),
    });
    await service.exec({ command: "pwd" });
    now.value = 2_000;
    await service.runComputeTick();
    expect(store.getComputeState()?.status).toBe("recoverable");
    const acquiresBefore = backend.acquireCalls.length;

    now.value = 7_000;
    await service.cleanupExpiredRecoverableCompute();

    expect(backend.acquireCalls).toHaveLength(acquiresBefore);
    expect(store.getComputeState()?.status).toBe("absent");
  });

  it("passes resolved environment and backend-neutral spec values to acquire", async () => {
    const backend = new FakeComputeBackend();
    const store = createMemoryComputeStore();
    const service = new ThreadComputeService({
      backend,
      store,
      config: { ...CONFIG, allowedHosts: ["example.com"] },
      environmentId: "thread_env",
      threadId: "thr_thread_service",
      env: { GH_TOKEN: "secret", NODE_ENV: "production" },
      setAlarm: async () => {},
      now: () => 1,
    });

    await service.exec({ command: "pwd" });

    expect(backend.acquireCalls[0]?.spec).toMatchObject({
      environmentId: "thread_env",
      profile: "small",
      workspaceRoot: "/workspace",
      env: { GH_TOKEN: "secret", NODE_ENV: "production" },
      maxProcessRuntimeMs: 10_000,
      allowedHosts: ["example.com"],
    });
  });

  it("rejects an active Daytona runtime acquired under a different egress policy", async () => {
    const backend = new FakeComputeBackend();
    const store = createMemoryComputeStore();
    const first = createService({
      backend,
      store,
      config: { ...CONFIG, provider: "daytona", allowedHosts: ["old.example.com"] },
    });
    await first.service.exec({ command: "true" });

    const changed = createService({
      backend,
      store,
      config: { ...CONFIG, provider: "daytona", allowedHosts: ["new.example.com"] },
    });

    await expect(changed.service.exec({ command: "true" })).rejects.toMatchObject({
      code: "policy_rejected",
    });
    expect(backend.acquireCalls).toHaveLength(1);
    expect(backend.destroyCalls).toHaveLength(0);
  });

  it("rejects a recoverable Daytona runtime acquired under a different egress policy", async () => {
    const backend = new FakeComputeBackend();
    const store = createMemoryComputeStore();
    const now = { value: 1_000 };
    const first = createService({
      backend,
      store,
      now,
      probeWorkspaceCleanliness: dirtyProbe(),
      config: { ...CONFIG, provider: "daytona", allowedHosts: ["old.example.com"] },
    });
    await first.service.exec({ command: "true" });
    now.value = 2_000;
    await first.service.runComputeTick();
    expect(store.getComputeState()?.status).toBe("recoverable");

    const changed = createService({
      backend,
      store,
      now,
      config: { ...CONFIG, provider: "daytona", allowedHosts: ["new.example.com"] },
    });

    await expect(changed.service.exec({ command: "true" })).rejects.toMatchObject({
      code: "policy_rejected",
    });
    expect(backend.acquireCalls).toHaveLength(1);
  });

  it("fails closed for a legacy Daytona runtime when the desired policy is explicit", async () => {
    const backend = new FakeComputeBackend();
    const store = createMemoryComputeStore();
    store.markAcquiring({ provider: "daytona", resourceProfile: "small", now: 1 });
    store.markActive(
      {
        provider: "daytona",
        version: 1,
        payload: { kind: "runtime", sandboxId: "legacy-daytona" },
      },
      2,
    );
    const changed = createService({
      backend,
      store,
      config: { ...CONFIG, provider: "daytona", allowedHosts: ["api.example.com"] },
    });

    await expect(changed.service.exec({ command: "true" })).rejects.toMatchObject({
      code: "policy_rejected",
    });
  });

  it("keeps a legacy Daytona runtime usable when the desired policy is unrestricted", async () => {
    const backend = new FakeComputeBackend();
    const store = createMemoryComputeStore();
    const runtime = await backend.acquire({
      environmentId: "legacy",
      profile: "small",
      workspaceRoot: "/workspace",
      env: {},
      maxProcessRuntimeMs: 10_000,
      allowedHosts: null,
    });
    backend.acquireCalls.length = 0;
    store.markAcquiring({ provider: "daytona", resourceProfile: "small", now: 1 });
    store.markActive(runtime, 2);
    const unchanged = createService({
      backend,
      store,
      config: { ...CONFIG, provider: "daytona", allowedHosts: null },
    });

    await expect(unchanged.service.exec({ command: "true" })).resolves.toMatchObject({ ok: true });
    expect(backend.acquireCalls).toHaveLength(0);
  });

  it("compares acquired Daytona policies canonically", async () => {
    const backend = new FakeComputeBackend();
    const store = createMemoryComputeStore();
    const first = createService({
      backend,
      store,
      config: {
        ...CONFIG,
        provider: "daytona",
        allowedHosts: [" API.EXAMPLE.COM ", "api.example.com"],
      },
    });
    await first.service.exec({ command: "true" });
    const equivalent = createService({
      backend,
      store,
      config: { ...CONFIG, provider: "daytona", allowedHosts: ["api.example.com"] },
    });

    await expect(equivalent.service.exec({ command: "true" })).resolves.toMatchObject({ ok: true });
  });

  it("returns the opaque active runtime reference for attached subagents", async () => {
    const { service, backend } = createService();

    const runtime = await service.ensureRuntimeReference();

    expect(runtime).toEqual(backend.acquireCalls[0]?.runtime);
  });

  it("polls watchers and delivers a provider-neutral completion notice", async () => {
    const backend = new FakeComputeBackend();
    const store = createMemoryComputeStore();
    const now = { value: 1_000 };
    const reminders: Array<{ body: string; mode: string }> = [];
    const service = new ThreadComputeService({
      backend,
      store,
      config: CONFIG,
      environmentId: "thread_watch",
      threadId: "thr_thread_service",
      env: {},
      setAlarm: async () => {},
      now: () => now.value,
      deliverSystemReminder: async ({ body, mode }) => void reminders.push({ body, mode }),
      supportsProcessMonitor: true,
    });
    const started = await service.execStart({ command: "sleep 30", label: "build" });
    await service.execWatch({ processId: started.processId, timeoutMs: 1_000 });
    const process = store.getProcess(started.processId);
    expect(process?.backendProcessRef).not.toBeNull();
    backend.finishProcess(process!.backendProcessRef!);

    now.value = 1_100;
    await service.runComputeTick();

    expect(store.countWatchers()).toBe(0);
    expect(store.getProcess(started.processId)?.status).toBe("exited");
    expect(reminders).toMatchObject([{ mode: "proactive" }]);
    expect(reminders[0]?.body).toContain("build");
  });

  it("renews a still-running watcher past its deadline instead of abandoning it, then delivers completion once it exits", async () => {
    const backend = new FakeComputeBackend();
    const store = createMemoryComputeStore();
    const now = { value: 1_000 };
    const reminders: Array<{ body: string; mode: string }> = [];
    const service = new ThreadComputeService({
      backend,
      store,
      config: CONFIG,
      environmentId: "thread_watch_renew",
      threadId: "thr_thread_service",
      env: {},
      setAlarm: async () => {},
      now: () => now.value,
      deliverSystemReminder: async ({ body, mode }) => void reminders.push({ body, mode }),
      supportsProcessMonitor: true,
    });
    const started = await service.execStart({ command: "sleep 600", label: "long" });
    await service.execWatch({ processId: started.processId, timeoutMs: 1_000 });

    // Deadline passes while the process is still running.
    now.value = 2_100;
    await service.runComputeTick();

    // Renewed, not abandoned: watcher survives, no reminder fired yet.
    expect(store.countWatchers()).toBe(1);
    expect(reminders).toEqual([]);
    expect(store.listWatchers()[0]?.deadlineAt).toBeGreaterThan(now.value);

    // The process finally exits on a later poll.
    const process = store.getProcess(started.processId);
    backend.finishProcess(process!.backendProcessRef!);
    now.value = 2_200;
    await service.runComputeTick();

    expect(store.countWatchers()).toBe(0);
    expect(store.getProcess(started.processId)?.status).toBe("exited");
    expect(reminders).toMatchObject([{ mode: "proactive" }]);
    expect(reminders[0]?.body).toContain("long");
  });

  it("clears provider-loss state, notifies the thread, and reacquires for the command", async () => {
    const backend = new FakeComputeBackend();
    const store = createMemoryComputeStore();
    const reminders: string[] = [];
    const service = new ThreadComputeService({
      backend,
      store,
      config: CONFIG,
      environmentId: "thread_loss",
      threadId: "thr_thread_service",
      env: {},
      setAlarm: async () => {},
      clearAlarm: async () => {},
      now: () => 1_000,
      deliverSystemReminder: async ({ body }) => void reminders.push(body),
    });
    await service.exec({ command: "pwd" });
    const firstRuntime = store.getComputeState()?.runtimeRef;
    expect(firstRuntime).not.toBeNull();
    backend.deleteRuntimeOutOfBand(firstRuntime!);

    const result = await service.exec({ command: "pwd" });

    expect(result.status).toBe("exited");
    expect(backend.acquireCalls).toHaveLength(2);
    expect(store.getComputeState()?.status).toBe("active");
    expect(reminders.join("\n")).toContain("missing from its backend");
  });
});

describe("ThreadComputeService.listActiveWatchersView output tail", () => {
  it("includes a bounded tail of the watched process's captured output", async () => {
    const { service, store, now } = createService();
    const started = await service.execStart({ command: "sleep 300", label: "build" });
    await service.execWatch({ processId: started.processId, timeoutMs: 1_000 });

    store.appendOutput({
      processId: started.processId,
      stream: "stdout",
      text: "line1\nline2\n",
      now: now.value,
    });

    const views = await service.listActiveWatchersView();

    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      processId: started.processId,
      label: "build",
    });
    expect(views[0]?.outputTail).toContain("line1");
    expect(views[0]?.outputTail).toContain("line2");
  });

  it("returns an empty tail when the watched process has produced no output", async () => {
    const { service } = createService();
    const started = await service.execStart({ command: "sleep 300" });
    await service.execWatch({ processId: started.processId, timeoutMs: 1_000 });

    const views = await service.listActiveWatchersView();

    expect(views[0]?.outputTail).toBe("");
  });
});

describe("ThreadComputeService acquisition profile preference", () => {
  it("prefers the profile persisted on state while a runtime still exists", async () => {
    // A runtime IS acquired at "medium" and then released as recoverable.
    // Resuming it must reuse "medium" — the box it is resuming was built that
    // way — even though the configuration now says "small".
    const backend = new FakeComputeBackend();
    const store = createMemoryComputeStore();
    const now = { value: 1_000 };
    const medium = await createService({
      backend,
      store,
      now,
      config: { ...CONFIG, resourceProfile: "medium" },
      probeWorkspaceCleanliness: dirtyProbe(),
    });
    await medium.service.exec({ command: "pwd" });
    now.value = 2_000;
    await medium.service.runComputeTick();
    expect(store.getComputeState()?.status).toBe("recoverable");
    expect(store.getComputeState()?.resourceProfile).toBe("medium");

    now.value = 2_500;
    const small = await createService({
      backend,
      store,
      now,
      probeWorkspaceCleanliness: dirtyProbe(),
    });
    await small.service.exec({ command: "pwd" });

    expect(backend.acquireCalls.at(-1)?.spec.profile).toBe("medium");
  });

  it("falls back to the configured profile once no runtime exists", async () => {
    // The stored profile survives `markAbsent`, so preferring it
    // unconditionally would freeze the profile of the very first acquire
    // forever — a thread retargeted to a smaller/larger environment would keep
    // provisioning the old size, from the old base image, with nothing to
    // correct it now the switch handshake's explicit "adopt" write is gone.
    const { service, backend, store, now } = createService();
    store.setResourceProfile("medium", now.value);
    store.markAbsent(now.value);

    await service.exec({ command: "pwd" });
    expect(backend.acquireCalls[0]?.spec.profile).toBe("small");
  });
});

describe("ThreadComputeService output retention signal", () => {
  function seedProcess(store: ThreadComputeStoreLike, overrides: Partial<ComputeProcessRecord>) {
    const record: ComputeProcessRecord = {
      id: "proc-ret",
      threadId: "thr_service_test",
      backendProcessRef: null,
      command: "yes",
      cwd: null,
      status: "exited",
      exitCode: 0,
      startedAt: 1,
      finishedAt: 2,
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutLines: 0,
      stderrLines: 0,
      outputTruncated: false,
      label: null,
      ...overrides,
    };
    store.createProcess(record);
    store.appendOutput({ processId: record.id, stream: "stdout", text: "kept line\n", now: 1 });
    return record.id;
  }

  it("flips limitReason to retention when stored output was truncated (execOutput)", async () => {
    const { service, store } = createService();
    const processId = seedProcess(store, { outputTruncated: true });

    const result = await service.execOutput({ processId });

    expect(result.limited).toBe(true);
    expect(result.limitReason).toBe("retention");
  });

  it("does not report retention when output was not truncated", async () => {
    const { service, store } = createService();
    const processId = seedProcess(store, { outputTruncated: false });

    const result = await service.execOutput({ processId });

    expect(result.limited).toBe(false);
    expect(result.limitReason).toBeUndefined();
  });

  it("surfaces retention through the grep and read paths too", async () => {
    const { service, store } = createService();
    const processId = seedProcess(store, { outputTruncated: true });

    const grep = await service.execOutputGrep({ processId, pattern: "kept" });
    expect(grep.limitReason).toBe("retention");

    const read = await service.execOutputRead({ processId });
    expect(read.limitReason).toBe("retention");
  });
});

describe("ThreadComputeService.execOutputHeadTail", () => {
  it("reports head, tail, and an exact hidden-line count for a long stream", async () => {
    const { service, store, now } = createService();
    const started = await service.execStart({ command: "sleep 300", label: "build" });
    for (let i = 1; i <= 50; i += 1) {
      store.appendOutput({
        processId: started.processId,
        stream: "stdout",
        text: `line ${i}\n`,
        now: now.value,
      });
    }

    const result = await service.execOutputHeadTail({ processId: started.processId });

    expect(result.head).toEqual(Array.from({ length: 20 }, (_, i) => `line ${i + 1}`));
    expect(result.tail).toEqual(Array.from({ length: 20 }, (_, i) => `line ${31 + i}`));
    // 50 total - 20 head - 20 tail = 10, and this must be reported, never
    // just dropped: a silent gap between head and tail is a repeat offender
    // in this codebase (see `hiddenLines`'s doc).
    expect(result.hiddenLines).toBe(10);
    expect(result.truncated).toBe(false);
    expect(result.stream).toBe("stdout");
  });

  it("returns everything with no hidden lines for a short stream", async () => {
    const { service, store, now } = createService();
    const started = await service.execStart({ command: "sleep 300" });
    store.appendOutput({
      processId: started.processId,
      stream: "stdout",
      text: "hi\n",
      now: now.value,
    });

    const result = await service.execOutputHeadTail({ processId: started.processId });
    expect(result).toEqual({
      head: ["hi"],
      tail: [],
      hiddenLines: 0,
      truncated: false,
      stream: "stdout",
    });
  });

  /**
   * Important 1: a command that writes its failure to stderr (the common case
   * for a failed build) must not read as "no output" just because the caller
   * defaulted to stdout — that's the exact row a user opens the sheet to
   * investigate. Mirrors the fallback `buildOutputTail` already uses for the
   * watcher-completion message.
   */
  it("falls back to stderr when stdout is empty, and reports which stream it returned", async () => {
    const { service, store, now } = createService();
    const started = await service.execStart({ command: "sleep 300" });
    store.appendOutput({
      processId: started.processId,
      stream: "stderr",
      text: "build failed: missing dependency\n",
      now: now.value,
    });

    const result = await service.execOutputHeadTail({ processId: started.processId });
    expect(result.stream).toBe("stderr");
    expect(result.head).toEqual(["build failed: missing dependency"]);
    expect(result.tail).toEqual([]);
  });

  it("does NOT fall back to stderr when the caller explicitly asked for stdout content that is genuinely empty and stderr also has nothing", async () => {
    const { service } = createService();
    const started = await service.execStart({ command: "sleep 300" });

    const result = await service.execOutputHeadTail({ processId: started.processId });
    expect(result.stream).toBe("stdout");
    expect(result).toMatchObject({ head: [], tail: [], hiddenLines: 0 });
  });

  it("does NOT fall back when the caller explicitly requested stderr", async () => {
    const { service, store, now } = createService();
    const started = await service.execStart({ command: "sleep 300" });
    store.appendOutput({
      processId: started.processId,
      stream: "stdout",
      text: "stdout line\n",
      now: now.value,
    });

    const result = await service.execOutputHeadTail({
      processId: started.processId,
      stream: "stderr",
    });
    expect(result.stream).toBe("stderr");
    expect(result).toMatchObject({ head: [], tail: [], hiddenLines: 0 });
  });

  it("clamps headLines/tailLines to limits.tailMaxLines like execOutput does", async () => {
    const { service, store, now } = createService();
    const started = await service.execStart({ command: "sleep 300" });
    // More lines than `CONFIG.limits.tailMaxLines` (200), so an unclamped
    // request would swallow the whole stream into `head` with an empty
    // `tail` — proving whether the clamp actually applied, not just that a
    // small stream happens to fit either way.
    const total = DEFAULT_COMPUTE_LIMITS.tailMaxLines + 50;
    for (let i = 1; i <= total; i += 1) {
      store.appendOutput({
        processId: started.processId,
        stream: "stdout",
        text: `line ${i}\n`,
        now: now.value,
      });
    }

    // A caller-supplied count far past the configured cap must not reach the
    // slicer unbounded — this callable is browser-reachable, unlike the
    // model-tool exec surfaces that already clamp the same way.
    const result = await service.execOutputHeadTail({
      processId: started.processId,
      headLines: 10_000,
      tailLines: 10_000,
    });
    expect(result.head).toHaveLength(DEFAULT_COMPUTE_LIMITS.tailMaxLines);
    expect(result.tail).toHaveLength(50);
    expect(result.hiddenLines).toBe(0);
  });

  it("surfaces retention truncation independently of hiddenLines", async () => {
    const { service, store, now } = createService();
    const started = await service.execStart({ command: "yes" });
    store.appendOutput({
      processId: started.processId,
      stream: "stdout",
      text: "kept\n",
      now: now.value,
    });
    store.updateProcess(started.processId, { outputTruncated: true });

    const result = await service.execOutputHeadTail({ processId: started.processId });
    expect(result.hiddenLines).toBe(0);
    expect(result.truncated).toBe(true);
  });

  it("throws for an unknown process id", async () => {
    const { service } = createService();
    await expect(service.execOutputHeadTail({ processId: "nope" })).rejects.toThrow(
      "sandbox_process_not_found",
    );
  });
});

describe("ThreadComputeService stopAllRunningProcesses", () => {
  // The UI stop button aborts the model turn, but anything the model launched
  // kept running in the container until it exited or hit maxProcessRuntimeMs.
  it("stops every running process and drops its watcher", async () => {
    const { service, store } = createService();
    const a = await service.execStart({ command: "sleep 300" });
    const b = await service.execStart({ command: "sleep 300" });
    await service.execWatch({ processId: a.processId });
    expect(store.listWatchers().length).toBe(1);

    const { stopped, failed } = await service.stopAllRunningProcesses();

    expect(stopped.sort()).toEqual([a.processId, b.processId].sort());
    expect(failed).toEqual([]);
    expect(store.getProcess(a.processId)?.status).not.toBe("running");
    expect(store.getProcess(b.processId)?.status).not.toBe("running");
    // A stopped process must not keep a watcher polling for a completion that
    // will never come.
    expect(store.listWatchers()).toEqual([]);
  });

  it("leaves already-finished processes alone", async () => {
    const { service, backend, store } = createService();
    const done = await service.execStart({ command: "sleep 300" });
    backend.finishProcess(store.getProcess(done.processId)!.backendProcessRef!, "exited", 0);
    await service.execStatus({ processId: done.processId });

    const { stopped } = await service.stopAllRunningProcesses();
    expect(stopped).toEqual([]);
  });

  // Resurrecting a released sandbox just to kill processes that died with it
  // would be absurd — and would bill the user for a container on a cancel.
  it("never provisions a runtime just to stop things", async () => {
    const { service, backend } = createService();
    await service.execStart({ command: "sleep 300" });
    // `confirm` is required while processes are still running — without it
    // execShutdown only asks, and the sandbox stays active.
    await service.execShutdown({ confirm: true });
    const acquiresBefore = backend.acquireCalls.length;

    const { stopped, failed } = await service.stopAllRunningProcesses();

    expect(stopped).toEqual([]);
    expect(failed).toEqual([]);
    expect(backend.acquireCalls.length).toBe(acquiresBefore);
  });
});

describe("ThreadComputeService execOutput status", () => {
  // The stored status only advances when a watcher poll runs, so exec_output
  // reported "running" for a process that had already exited. `waitMs` (accepted
  // and silently ignored) pretended to paper over this. Ask the provider instead.
  it("reports the provider's status, not the stale stored one", async () => {
    const { service, backend, store } = createService();
    const started = await service.execStart({ command: "sleep 300" });
    expect(store.getProcess(started.processId)?.status).toBe("running");

    // The process exits in the container. No watcher runs.
    backend.finishProcess(store.getProcess(started.processId)!.backendProcessRef!, "exited", 0);

    const out = await service.execOutput({ processId: started.processId });
    expect(out.status).toBe("exited");
    expect(out.exitCode).toBe(0);
  });

  it("includes anti-poll guidance while the process is still running", async () => {
    const { service, store } = createService();
    const started = await service.execStart({ command: "sleep 300" });
    expect(store.getProcess(started.processId)?.status).toBe("running");

    const out = await service.execOutput({ processId: started.processId });

    expect(out.status).toBe("running");
    expect(out.guidance).toContain("Do not call exec_output in a loop");
  });

  it("omits guidance once the process has exited", async () => {
    const { service, backend, store } = createService();
    const started = await service.execStart({ command: "sleep 300" });
    backend.finishProcess(store.getProcess(started.processId)!.backendProcessRef!, "exited", 0);

    const out = await service.execOutput({ processId: started.processId });

    expect(out.status).toBe("exited");
    expect(out.guidance).toBeUndefined();
  });
});

describe("ThreadComputeService execRun", () => {
  it("keeps a synchronous exec cancellable while it waits for completion", async () => {
    const { service, backend, store } = createService({ backgroundLongRunningExec: false });
    let releaseStream: (() => void) | undefined;
    (
      backend as unknown as {
        waitForProcessExit: () => Promise<{ status: "stopped" }>;
      }
    ).waitForProcessExit = async () => {
      await new Promise<void>((resolve) => {
        releaseStream = resolve;
      });
      return { status: "stopped" };
    };

    const exec = service.exec({ command: "sleep 300" });
    await vi.waitFor(() => expect(store.listProcesses(1_000)).toHaveLength(1));

    const stopped = await service.stopAllRunningProcesses();

    expect(stopped.failed).toEqual([]);
    expect(stopped.stopped).toEqual([store.listProcesses(1_000)[0]!.id]);
    releaseStream?.();
    await expect(exec).resolves.toMatchObject({ status: "stopped" });
  });

  it("exec waits through the foreground window when backgrounding is disabled", async () => {
    const now = { value: 1_000 };
    const { service, backend, store } = createService({
      now,
      backgroundLongRunningExec: false,
      execForegroundTimeoutMs: 1,
      execForegroundPollIntervalMs: 1,
      sleep: async (ms) => void (now.value += ms),
    });
    const result = await service.exec({ command: "sleep 30" });

    expect(result.status).toBe("exited");
    expect(result).not.toHaveProperty("watching");
    expect(store.listWatchers()).toEqual([]);
    expect(backend.runCommandCalls.map((call) => call.command)).toEqual(["sleep 30"]);
  });

  // execRun exists because polling a process's status across its exit wedges the
  // Cloudflare RPC session for ~10 minutes. It must go through the backend's
  // blocking runCommand and never start a pollable process.
  it("runs via the backend's blocking runCommand, not startProcess", async () => {
    const { service, backend } = createService();
    const result = await service.execRun({ command: "echo hi", label: "skill:x" });

    expect(result.status).toBe("exited");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hi\n");
    expect(backend.runCommandCalls.map((c) => c.command)).toEqual(["echo hi"]);
    // No background process was started — there is nothing to poll, by design.
    expect(backend.startProcessCalls).toEqual([]);
  });

  /**
   * The cwd default lives at TWO call sites — `exec`'s blocking-runCommand path
   * and `startAndStoreProcess` — and the tests above only reach the second. One
   * of them reverting to `/workspace` is a partial regression a
   * `startProcess`-only assertion cannot see; it is the one the first mutation
   * pass on this change actually produced.
   */
  it("the blocking runCommand path defaults to the thread's directory too", async () => {
    const now = { value: 1_000 };
    const { service, backend } = createService({
      now,
      backgroundLongRunningExec: false,
      execForegroundTimeoutMs: 1,
      execForegroundPollIntervalMs: 1,
      sleep: async (ms) => void (now.value += ms),
    });

    await service.exec({ command: "pwd" });
    await service.exec({ command: "pwd", cwd: "/tmp" });

    expect(backend.runCommandCalls.map((call) => call.cwd)).toEqual([
      threadWorkRoot("thread_test"),
      "/tmp",
    ]);
    expect(backend.runCommandCalls[0]?.cwd).not.toBe("/workspace");
  });

  /**
   * DATA LOSS GUARD (companion to workspace-cleanliness.test.ts). A backend
   * without `runCommand` falls back to start-and-poll, which returns
   * `buildPreview`'s TAIL. `execRun` must say so — a caller that decides from
   * stdout (the cleanliness probe decides whether to DESTROY the sandbox)
   * cannot tell a line-aligned cut from complete output on its own.
   */
  it("reports stdoutTruncated when the start-and-poll fallback returns only a tail", async () => {
    const backend = new FakeComputeBackend();
    // No blocking runCommand → the fallback path, the only one that tails.
    (backend as unknown as { runCommand?: unknown }).runCommand = undefined;
    backend.setNextProcessResult({
      status: "exited",
      exitCode: 0,
      stdout: `${Array.from({ length: DEFAULT_COMPUTE_LIMITS.tailMaxLines + 50 }, (_, i) => `line ${i}`).join("\n")}\n`,
    });
    const { service } = createService({ backend });
    const result = await service.execRun({ command: "spew" });

    expect(result.stdoutTruncated).toBe(true);
    // And it really is a tail: the head is gone.
    expect(result.stdout).not.toContain("line 0\n");
  });

  it("reports stdoutTruncated false when the backend returns the whole output", async () => {
    const { service } = createService();
    const result = await service.execRun({ command: "echo hi" });
    expect(result.stdoutTruncated).toBe(false);
  });

  it("records the completed run in the store so it stays observable", async () => {
    const { service, store } = createService();
    const result = await service.execRun({ command: "echo hi", label: "skill:x" });

    const process = store.getProcess(result.processId);
    expect(process?.status).toBe("exited");
    expect(process?.exitCode).toBe(0);
    expect(process?.label).toBe("skill:x");
    expect(process?.finishedAt).not.toBeNull();
  });
});

describe("ThreadComputeService execStatus", () => {
  // Regression: execOutput's status is store-only and never advances without a
  // watcher, so the skill-script runner's completion poll hung forever.
  // execStatus must ask the backend while the store still says "running".
  it("returns the backend's fresh status and persists a terminal transition", async () => {
    const { service, backend, store } = createService();
    const started = await service.execStart({ command: "sleep 30" });

    expect((await service.execStatus({ processId: started.processId })).status).toBe("running");
    expect(store.getProcess(started.processId)?.status).toBe("running");

    const ref = store.getProcess(started.processId)!.backendProcessRef!;
    backend.finishProcess(ref, "exited", 0);

    const fresh = await service.execStatus({ processId: started.processId });
    expect(fresh).toMatchObject({ status: "exited", exitCode: 0 });
    expect(store.getProcess(started.processId)).toMatchObject({ status: "exited", exitCode: 0 });
  });

  it("never provisions a runtime just to poll: absent compute reports the stored status", async () => {
    const { service, backend, store, now } = createService({
      probeWorkspaceCleanliness: async () => ({ state: "clean" }),
    });
    const started = await service.execStart({ command: "sleep 30" });
    now.value = 2_000;
    await service.runComputeTick(); // idle-discards the runtime (probe proves it clean)

    const result = await service.execStatus({ processId: started.processId });

    expect(result.status).toBe(store.getProcess(started.processId)?.status);
    expect(backend.acquireCalls.length).toBe(1); // no re-acquire for a poll
  });
});

describe("ThreadComputeService download mime", () => {
  it("carries a provider-supplied mime through execDownloadFile", async () => {
    const { service, backend, store } = createService();
    await service.exec({ command: "pwd" });
    const runtime = store.getComputeState()?.runtimeRef;
    expect(runtime).toBeTruthy();
    backend.seedFile(runtime!, "/workspace/logo.png", new Uint8Array([1, 2, 3]), "image/png");

    const download = await service.execDownloadFile({
      path: "/workspace/logo.png",
      maxBytes: 1024,
    });

    expect(download.mimeType).toBe("image/png");
    expect(download.filename).toBe("logo.png");
    expect(download.bytes.byteLength).toBe(3);
  });

  it("omits mime when the provider supplies none", async () => {
    const { service, backend, store } = createService();
    await service.exec({ command: "pwd" });
    const runtime = store.getComputeState()?.runtimeRef;
    await backend.writeFile(runtime!, "/workspace/plain.bin", new Uint8Array([9]).buffer, {
      createParents: false,
      overwrite: true,
    });

    const download = await service.execDownloadFile({
      path: "/workspace/plain.bin",
      maxBytes: 1024,
    });

    expect(download.mimeType).toBeUndefined();
  });
});

describe("ThreadComputeService workspace root provisioning", () => {
  /**
   * `backend.acquire` creates the workspace root, but an already-active runtime
   * never re-acquires — and exec now defaults `cwd` to it. Without this, every
   * sandbox that was running before the root existed would exec into a missing
   * directory.
   */
  function recordingBackend() {
    const backend = new FakeComputeBackend();
    const createdDirs: string[] = [];
    const original = backend.createDirectory.bind(backend);
    backend.createDirectory = async (runtime, path) => {
      createdDirs.push(path);
      return original(runtime, path);
    };
    return { backend, createdDirs };
  }

  it("creates the workspace root and the thread's own directory on a reused active runtime, once", async () => {
    const { backend, createdDirs } = recordingBackend();
    const { service } = createService({ backend });

    await service.exec({ command: "true" });
    await service.exec({ command: "true" });

    expect(createdDirs.filter((path) => path === "/workspace")).toHaveLength(1);
    // The thread's directory is the cwd exec defaults to AND the root the file
    // tools fail closed on (`workspace_root_missing`), so `/workspace` alone is
    // not enough: a box whose first exec came from a thread that never got its
    // directory would exec into nothing.
    expect(createdDirs.filter((path) => path === threadWorkRoot("thread_test"))).toHaveLength(1);
  });

  it("creates the workspace root on an attached runtime that never acquires", async () => {
    const { backend, createdDirs } = recordingBackend();
    const attachedRuntime = await backend.acquire({
      environmentId: "parent",
      profile: "small",
      workspaceRoot: "/workspace",
      env: {},
      maxProcessRuntimeMs: 1_000,
      allowedHosts: null,
    });
    createdDirs.length = 0;

    const service = new ThreadComputeService({
      backend,
      store: createMemoryComputeStore(),
      config: CONFIG,
      environmentId: "thread_attached",
      threadId: "thr_thread_service",
      env: {},
      attachedRuntime,
      setAlarm: async () => {},
      now: () => 1_000,
    });

    await service.exec({ command: "true" });

    expect(createdDirs).toContain("/workspace");
    expect(createdDirs).toContain(threadWorkRoot("thr_thread_service"));
  });

  it("defaults exec cwd to the thread's working directory but honors an explicit cwd", async () => {
    const { service, backend } = createService();
    await service.exec({ command: "true" });
    await service.exec({ command: "true", cwd: "/tmp" });
    expect(backend.startProcessCalls.map((call) => call.cwd)).toEqual([
      threadWorkRoot("thread_test"),
      "/tmp",
    ]);
  });

  /**
   * The point of the whole task: two threads of ONE agent, one box, two working
   * directories. A service that fell back to a shared root would pass every
   * other test in this file.
   */
  it("gives two threads of one box different working directories", async () => {
    const backend = new FakeComputeBackend();
    const store = createMemoryComputeStore();
    const build = (threadId: string) =>
      new ThreadComputeService({
        backend,
        store,
        config: CONFIG,
        environmentId: "agent_shared_box",
        threadId,
        env: {},
        setAlarm: async () => {},
        now: () => 1_000,
      });

    await build("thr_aaaaaaaa").exec({ command: "pwd" });
    await build("thr_bbbbbbbb").exec({ command: "pwd" });

    const [first, second] = backend.startProcessCalls.slice(-2);
    expect(first?.cwd).toBe(threadWorkRoot("thr_aaaaaaaa"));
    expect(second?.cwd).toBe(threadWorkRoot("thr_bbbbbbbb"));
  });

  /**
   * The subagent shape: a service whose ROUTING thread and whose WORKING
   * DIRECTORY are different threads.
   *
   * `threadId` is a run id — it stamps ledger rows and routes reminders. The
   * directory belongs to the parent, because that is where the checkout is.
   * Nothing else in this file would notice the two being conflated: every other
   * service here routes and works as the same thread.
   */
  it("works in workspaceThreadId's directory while still routing as threadId", async () => {
    const backend = new FakeComputeBackend();
    const service = new ThreadComputeService({
      backend,
      store: createMemoryComputeStore(),
      config: CONFIG,
      environmentId: "agent_shared_box",
      threadId: "run_abcdef",
      workspaceThreadId: "thr_parent_of_run",
      env: {},
      setAlarm: async () => {},
      now: () => 1_000,
    });

    await service.exec({ command: "pwd" });

    expect(backend.startProcessCalls.at(-1)?.cwd).toBe(threadWorkRoot("thr_parent_of_run"));
    expect(backend.startProcessCalls.at(-1)?.cwd).not.toBe(threadWorkRoot("run_abcdef"));
    // And the file tools resolve there too — `read_file("src/x.ts")` and
    // `exec("cat src/x.ts")` must still name one file for a subagent.
    expect(
      (service.files as unknown as { deps: { workspaceRoot: string } }).deps.workspaceRoot,
    ).toBe(threadWorkRoot("thr_parent_of_run"));
  });

  /**
   * `threadId` is a required dep, but the type cannot exclude `""` — and `""`
   * would resolve to `/workspace/threads`, the parent EVERY other thread's
   * directory lives under. An exec there, or a `write_file` relative to it,
   * lands in a directory that is not this thread's and is not empty. Loud, not
   * defaulted.
   */
  it("refuses to run for a service with an empty threadId", async () => {
    const service = new ThreadComputeService({
      backend: new FakeComputeBackend(),
      store: createMemoryComputeStore(),
      config: CONFIG,
      environmentId: "thread_degenerate",
      threadId: "",
      env: {},
      setAlarm: async () => {},
      now: () => 1_000,
    });

    await expect(service.exec({ command: "true" })).rejects.toThrow("unsafe thread id");
  });
});

describe("retention: preserve by default, discard only on proof", () => {
  it("discards when the workspace was declared clean, without probing", async () => {
    const probe = vi.fn();
    const { service, backend } = createService({
      isSandboxDeclaredClean: async () => true,
      probeWorkspaceCleanliness: probe,
    });
    await makeIdle(service);
    await service.releaseIfIdle();
    expect(backend.releaseCalls[0]?.options.disposition).toBe("discard");
    expect(probe).not.toHaveBeenCalled();
  });

  it("discards when git proves every repo clean", async () => {
    const { service, backend } = createService({
      isSandboxDeclaredClean: async () => false,
      probeWorkspaceCleanliness: async () => ({ state: "clean" as const }),
    });
    await makeIdle(service);
    await service.releaseIfIdle();
    expect(backend.releaseCalls[0]?.options.disposition).toBe("discard");
  });

  /**
   * The two deciders must agree about an EMPTY workspace. `confirmWorkSaved`
   * accepts `no_repo{hasFiles:false}` and sets the bit ("Workspace is empty"),
   * so the release path treating the same state as recoverable meant every
   * repo-less thread that ran a single `exec` — a bare command leaves
   * /workspace empty, and a chat thread never calls `confirm_work_saved` —
   * held a 24h recovery snapshot for nothing.
   */
  it("discards an EMPTY workspace: no repo and no files is nothing to lose", async () => {
    const { service, backend } = createService({
      isSandboxDeclaredClean: async () => false,
      probeWorkspaceCleanliness: async () => ({ state: "no_repo" as const, hasFiles: false }),
    });
    await makeIdle(service);
    await service.releaseIfIdle();
    expect(backend.releaseCalls[0]?.options.disposition).toBe("discard");
  });

  const dispositionCases: Array<[string, WorkspaceCleanliness]> = [
    [
      "a dirty repo",
      { state: "dirty", repos: [{ path: "/workspace/a", changes: [" M x"], unpushed: 0 }] },
    ],
    // The other `no_repo` arm — unversioned files ARE work worth keeping.
    ["no repo but unversioned files present", { state: "no_repo", hasFiles: true }],
    ["a failed probe", { state: "probe_failed", reason: "unreachable" }],
  ];
  for (const [name, cleanliness] of dispositionCases) {
    it(`preserves on ${name}`, async () => {
      const { service, backend } = createService({
        isSandboxDeclaredClean: async () => false,
        probeWorkspaceCleanliness: async () => cleanliness,
      });
      await makeIdle(service);
      await service.releaseIfIdle();
      expect(backend.releaseCalls[0]?.options.disposition).toBe("recoverable");
    });
  }

  it("logs the retention decision with a dirty-repo COUNT, never repo paths", async () => {
    // `reason` is the only after-the-fact record of WHY a sandbox was
    // destroyed or preserved — worth asserting exactly, per the pattern in
    // automaton-scheduled.integration.test.ts. The dirty repo's `path` must
    // never appear in the payload (paths can carry sensitive project names).
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => {});
    const { service } = createService({
      isSandboxDeclaredClean: async () => false,
      probeWorkspaceCleanliness: async () => ({
        state: "dirty",
        repos: [
          { path: "/workspace/secret-project", changes: [" M x"], unpushed: 0 },
          { path: "/workspace/another", changes: [], unpushed: 1 },
        ],
      }),
    });
    await makeIdle(service);
    await service.releaseIfIdle();
    expect(infoSpy).toHaveBeenCalledWith("compute.retention_decision", {
      threadId: "thread_test",
      disposition: "recoverable",
      reason: "dirty",
      dirtyRepoCount: 2,
    });
    const dirtyCall = infoSpy.mock.calls.find(([event]) => event === "compute.retention_decision");
    expect(JSON.stringify(dirtyCall)).not.toContain("secret-project");
    infoSpy.mockRestore();
  });

  it("logs declared_clean without invoking the probe", async () => {
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => {});
    const { service } = createService({ isSandboxDeclaredClean: async () => true });
    await makeIdle(service);
    await service.releaseIfIdle();
    expect(infoSpy).toHaveBeenCalledWith("compute.retention_decision", {
      threadId: "thread_test",
      disposition: "discard",
      reason: "declared_clean",
    });
    infoSpy.mockRestore();
  });

  /**
   * The inferred discards (git-clean, empty workspace) exist to stop a runtime
   * that would otherwise bill while idle — Daytona and Cloudflare deliberately
   * disable native idle handling. A provider that suspends itself (Sprites)
   * already stopped the meter, so inferring a discard buys only disk and pays
   * for it in destroyed work. A real user lost a sandbox exactly this way.
   */
  describe("providers that suspend an idle runtime themselves", () => {
    const nativeIdleBackend = () =>
      Object.assign(new FakeComputeBackend(), { nativeIdleSuspend: true });

    it("preserves an EMPTY workspace instead of discarding it on inference", async () => {
      const backend = nativeIdleBackend();
      const { service } = createService({
        backend,
        isSandboxDeclaredClean: async () => false,
        probeWorkspaceCleanliness: async () => ({ state: "no_repo" as const, hasFiles: false }),
      });
      await makeIdle(service);
      await service.releaseIfIdle();
      expect(backend.releaseCalls[0]?.options.disposition).toBe("recoverable");
    });

    it("preserves a git-clean workspace too, and skips the probe round-trip", async () => {
      const probe = vi.fn(async () => ({ state: "clean" as const }));
      const backend = nativeIdleBackend();
      const { service } = createService({
        backend,
        isSandboxDeclaredClean: async () => false,
        probeWorkspaceCleanliness: probe,
      });
      await makeIdle(service);
      await service.releaseIfIdle();
      expect(backend.releaseCalls[0]?.options.disposition).toBe("recoverable");
      // The verdict cannot change the outcome, and the probe is an exec
      // round-trip on every idle timer.
      expect(probe).not.toHaveBeenCalled();
    });

    it("still discards on an explicit declared-clean signal", async () => {
      // Stated intent, not an inference: discarding then frees disk on purpose.
      const backend = nativeIdleBackend();
      const { service } = createService({ backend, isSandboxDeclaredClean: async () => true });
      await makeIdle(service);
      await service.releaseIfIdle();
      expect(backend.releaseCalls[0]?.options.disposition).toBe("discard");
    });

    it("logs the decision with its own reason so it stays diagnosable", async () => {
      const infoSpy = vi.spyOn(log, "info").mockImplementation(() => {});
      const { service } = createService({
        backend: nativeIdleBackend(),
        isSandboxDeclaredClean: async () => false,
        probeWorkspaceCleanliness: async () => ({ state: "clean" as const }),
      });
      await makeIdle(service);
      await service.releaseIfIdle();
      expect(infoSpy).toHaveBeenCalledWith("compute.retention_decision", {
        threadId: "thread_test",
        disposition: "recoverable",
        reason: "provider_native_idle",
      });
      infoSpy.mockRestore();
    });
  });

  it("preserves when no probe dep is wired at all — the absent-probe safety default", async () => {
    // A review of Task 4 found this default (absent `probeWorkspaceCleanliness`
    // resolves to `probe_failed`, never `clean`) was only covered incidentally,
    // by fixtures elsewhere in this file that happen to omit the dep for other
    // reasons. This test's stated purpose IS that default: no `isSandboxDeclaredClean`
    // and no `probeWorkspaceCleanliness` are passed to `createService` at all,
    // unlike every case above.
    const { service, backend } = createService();
    await makeIdle(service);
    await service.releaseIfIdle();
    expect(backend.releaseCalls[0]?.options.disposition).toBe("recoverable");
  });
});

/**
 * FIX ROUND 2 — the reason a background command has no watcher must be one the
 * model can ACT on.
 *
 * `createComputeTools` exposes `exec`, `exec_output`, `exec_output_grep`,
 * `exec_output_read`, `exec_stop`, `exec_shutdown`, `exec_list`,
 * `exec_upload_file`, `exec_download_file`, `exec_publish_artifact` — and no
 * `exec_watch` or `exec_unwatch`. An earlier draft of this message told the
 * model to "use exec_unwatch on one to free a slot", advice it cannot follow
 * and would spend a turn discovering. Watchers are attached by the runtime, not
 * by the model.
 */
describe("a watcher refusal explains itself in tools the model actually has", () => {
  /** Every compute tool `createComputeTools` defines. Kept literal on purpose. */
  const EXPOSED_TOOLS = [
    "exec",
    "exec_output",
    "exec_output_grep",
    "exec_output_read",
    "exec_stop",
    "exec_shutdown",
    "exec_list",
    "exec_upload_file",
    "exec_download_file",
    "exec_publish_artifact",
  ];

  function unknownToolsIn(text: string): string[] {
    return [...text.matchAll(/\bexec(?:_[a-z_]+)?\b/g)]
      .map((match) => match[0])
      .filter((name) => !EXPOSED_TOOLS.includes(name));
  }

  async function backgroundedWithFullThreadQuota() {
    // The clock is frozen unless a test moves it, and the foreground poll loop
    // spins on `now() - startedAt < foregroundTimeoutMs`. A no-op `sleep` with
    // a frozen clock is an infinite loop, so the fake sleep ADVANCES the clock
    // by exactly what it was asked to wait — which is what a real sleep does.
    const now = { value: 1_000 };
    const { service } = createService({
      now,
      supportsProcessMonitor: true,
      backgroundLongRunningExec: true,
      execForegroundTimeoutMs: 5,
      execForegroundPollIntervalMs: 5,
      sleep: async (ms: number) => void (now.value += Math.max(ms, 1)),
    });
    // Fill this thread's own quota (MAX_WATCHERS_PER_THREAD = 8).
    for (let index = 0; index < 8; index += 1) {
      const started = await service.execStart({ command: `sleep ${100 + index}` });
      await service.execWatch({ processId: started.processId });
    }
    const result = await service.exec({ command: "sleep 900" });
    if (result.status !== "backgrounded")
      throw new Error(`expected backgrounded: ${result.status}`);
    return result;
  }

  it("names the limit that refused it", async () => {
    const result = await backgroundedWithFullThreadQuota();
    expect(result.watching).toBe(false);
    expect(result.message).toContain("its limit");
    expect(
      result.message,
      "the model has to learn WHY it will hear nothing, not just that it will",
    ).toContain("will not announce itself");
  });

  it("suggests no tool that does not exist", async () => {
    const result = await backgroundedWithFullThreadQuota();
    const surface = [result.message, ...result.nextActions].join(" ");
    expect(
      unknownToolsIn(surface),
      "advice naming a tool the model cannot call costs it a turn to discover",
    ).toEqual([]);
  });
});
